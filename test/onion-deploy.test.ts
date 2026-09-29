import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ONION_HEADER } from "../src/lib/onion.ts";

// The onion service image and its Railway description, checked as files. (The image itself is built and started by hand;
// see deploy/onion/README.md.) These tests hold the properties that must not drift: pinned inputs, no logging, the
// marker header set by the proxy, and a health check that exposes nothing.

const root = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const dockerfile = read("deploy/onion/Dockerfile");
const haproxy = read("deploy/onion/haproxy.cfg");
const torrc = read("deploy/onion/torrc");
const entrypoint = read("deploy/onion/entrypoint.sh");
const readme = read("deploy/onion/README.md");
const railway = JSON.parse(read("deploy/railway/onion.railway.json"));
/** The directives of a config file: comments and blank lines dropped. */
const directives = (text: string) => text.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);

describe("the image", () => {
  test("the base image is pinned by digest and every package by exact version", () => {
    for (const m of dockerfile.matchAll(/^FROM\s+(\S+)/gm)) expect(m[1]).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    const install = /apk add[^\n]*(?:\\\n[^\n]*)*/.exec(dockerfile)![0];
    expect(install).toContain("--no-cache");
    for (const pkg of ["tor", "haproxy", "su-exec"]) expect(install).toMatch(new RegExp(`"${pkg}=\\$\\{[A-Z_]+\\}"`));
    for (const arg of ["TOR_VERSION", "HAPROXY_VERSION", "SU_EXEC_VERSION"]) expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=\\d+\\.\\d+(?:\\.\\d+)*(?:\\.\\d+)?-r\\d+$`, "m"));
    expect(dockerfile).not.toMatch(/:latest|apk upgrade/);
  });

  test("no VOLUME instruction (mounted storage is the platform's), a health check that needs no extra tooling, one entry point", () => {
    expect(dockerfile).not.toMatch(/^VOLUME\b/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*wget -q -O \/dev\/null "http:\/\/127\.0\.0\.1:\$\{PORT\}\/healthz"/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/onion-entrypoint"\]$/m);
    expect(dockerfile).not.toMatch(/curl|apt-get|--privileged/);
  });

  test("the build context is only the three files the image copies", () => {
    const ignore = directives(read("deploy/onion/Dockerfile.dockerignore"));
    expect(ignore).toEqual(["*", "!deploy/onion/torrc", "!deploy/onion/haproxy.cfg", "!deploy/onion/entrypoint.sh"]);
    for (const f of ["torrc", "haproxy.cfg", "entrypoint.sh"]) expect(dockerfile).toContain(`COPY deploy/onion/${f} `);
  });
});

describe("the proxy", () => {
  const lines = directives(haproxy);

  test("writes no log of any kind", () => {
    expect(lines.filter((l) => /^(log|log-tag|log-format|option (httplog|tcplog|dontlognull|logasap|log-health-checks)|stats|capture|http-request capture|http-request (set-log-level|do-log)|unique-id)/.test(l))).toEqual([]);
    expect(haproxy).not.toMatch(/\/dev\/log|syslog/i);
  });

  test("sets the marker header from the environment after removing any the client sent, and the header is the one the router reads", () => {
    const del = lines.indexOf(`http-request del-header ${ONION_HEADER}`);
    const set = lines.indexOf(`http-request set-header ${ONION_HEADER} "\${ONION_PROXY_SECRET}"`);
    expect(del).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(del);
    // The secret comes from the environment; it is never written into the file.
    expect(haproxy).not.toMatch(/set-header [a-z-]+ "[^$"][^"]{20,}"/);
  });

  test("strips every header that names a client address, and adds none", () => {
    for (const h of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "true-client-ip", "cf-connecting-ip", "x-client-ip", "via"]) expect(lines).toContain(`http-request del-header ${h}`);
    expect(lines.filter((l) => /forwardfor|originalto|proxy-protocol|send-proxy/.test(l))).toEqual([]);
  });

  test("Tor's side listens on loopback only; the only other listener is the health one and answers one path with one word", () => {
    const binds = lines.filter((l) => l.startsWith("bind "));
    expect(binds).toEqual(["bind 127.0.0.1:18080", 'bind "${HEALTH_BIND}" v4v6']);
    const health = haproxy.slice(haproxy.indexOf("frontend health"));
    expect(health).not.toContain("default_backend");
    expect(health).not.toContain("use_backend");
    expect(directives(health).filter((l) => l.startsWith("http-request return"))).toEqual([
      "http-request return status 200 content-type text/plain string ok if { path /healthz } { method GET HEAD }",
      "http-request return status 404 content-type text/plain string no",
    ]);
    expect(torrc).toContain("HiddenServicePort 80 127.0.0.1:18080");
  });

  test("the upstream is looked up again as its answers expire", () => {
    expect(lines).toContain("parse-resolv-conf");
    expect(lines.find((l) => l.startsWith("server router"))).toContain("resolvers dns init-addr libc,none");
  });
});

describe("tor", () => {
  const lines = directives(torrc);

  test("a version 3 service, no SOCKS or control port, and nothing verbose in the log", () => {
    expect(lines).toContain("HiddenServiceVersion 3");
    expect(lines).toContain("SocksPort 0");
    expect(lines.filter((l) => /^(ControlPort|ControlSocket|HashedControlPassword|CookieAuthentication|ORPort|DirPort|ExitRelay|SocksPolicy|TransPort|DNSPort|HTTPTunnelPort)\b/.test(l))).toEqual([]);
    expect(lines).toContain("SafeLogging 1");
    expect(lines.filter((l) => l.startsWith("Log ") && !/^Log notice (stdout|file )/.test(l))).toEqual([]);
    expect(lines).toContain("HiddenServiceDir /var/lib/tor/hidden_service");
  });

  test("the single-hop lines are added only on request", () => {
    expect(torrc).not.toContain("HiddenServiceNonAnonymousMode");
    expect(entrypoint).toMatch(/if \[ "\$SINGLE_HOP" = 1 \]; then[\s\S]*HiddenServiceNonAnonymousMode 1[\s\S]*HiddenServiceSingleHopMode 1[\s\S]*fi/);
    expect(entrypoint).toMatch(/false\|0\|no\|''\) SINGLE_HOP=0/);
  });
});

describe("the entry point", () => {
  const run = (env: Record<string, string>) => {
    const r = Bun.spawnSync(["sh", resolve(root, "deploy/onion/entrypoint.sh")], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

  test("is valid POSIX shell", () => {
    expect(Bun.spawnSync(["sh", "-n", resolve(root, "deploy/onion/entrypoint.sh")]).exitCode).toBe(0);
  });

  test("refuses to start, before touching anything, without a usable upstream and secret", () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{}, /ONION_UPSTREAM is required/],
      [{ ONION_UPSTREAM: "https://api.internal:8787", ONION_PROXY_SECRET: SECRET }, /must look like http:\/\/host:port/],
      [{ ONION_UPSTREAM: "http://user:pw@api.internal:8787", ONION_PROXY_SECRET: SECRET }, /must look like http:\/\/host:port/],
      [{ ONION_UPSTREAM: "http://api.internal:8787/v1", ONION_PROXY_SECRET: SECRET }, /must look like http:\/\/host:port/],
      [{ ONION_UPSTREAM: "http://api.internal:70000", ONION_PROXY_SECRET: SECRET }, /invalid port/],
      [{ ONION_UPSTREAM: "http://api.internal:8787" }, /ONION_PROXY_SECRET is required/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: "short" }, /32 to 200 characters/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: `${SECRET},${SECRET}` }, /32 to 200 characters/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: `${SECRET}"; x` }, /32 to 200 characters/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: SECRET, PORT: "18080" }, /not 18080/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: SECRET, PORT: "80" }, /between 1024 and 65535/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: SECRET, PORT: "web" }, /PORT must be a number/],
      [{ ONION_UPSTREAM: "http://api.internal:8787", ONION_PROXY_SECRET: SECRET, ONION_SINGLE_HOP: "maybe" }, /ONION_SINGLE_HOP must be true or false/],
    ];
    for (const [env, message] of bad) {
      const r = run(env);
      expect(r.code, JSON.stringify(env)).toBe(64);
      expect(r.err).toMatch(message);
      expect(r.out).toBe("");
    }
  });

  test("drops privileges for both daemons, and stops the container if either one stops", () => {
    expect(entrypoint).toContain('AS_TOR="su-exec tor:tor"');
    expect(entrypoint).toContain('AS_PROXY="su-exec haproxy:haproxy"');
    expect(entrypoint).toMatch(/while kill -0 "\$TOR_PID"[^\n]*kill -0 "\$PROXY_PID"/);
    expect(entrypoint).toMatch(/stop_all\nexit 1\n$/);
    // The proxy (and with it the health listener) is started only after Tor reports it has bootstrapped.
    expect(entrypoint.indexOf("Bootstrapped 100%")).toBeLessThan(entrypoint.indexOf("haproxy -f /etc/onion/haproxy.cfg"));
  });

  test("never echoes the secret", () => {
    for (const line of entrypoint.split("\n")) {
      const message = /\b(?:say|die)\s+"(.*)$/.exec(line)?.[1];
      if (message) expect(message).not.toMatch(/\$\{?ONION_PROXY_SECRET/);
    }
    expect(entrypoint).not.toMatch(/echo[^\n]*ONION_PROXY_SECRET/);
  });
});

describe("Railway", () => {
  test("one service on a Dockerfile that exists, health-checked on /healthz, exactly one replica, restarted on failure", () => {
    expect(railway.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "deploy/onion/Dockerfile" });
    expect(existsSync(resolve(root, railway.build.dockerfilePath))).toBe(true);
    expect(railway.deploy).toMatchObject({ healthcheckPath: "/healthz", restartPolicyType: "ON_FAILURE", numReplicas: 1 });
    expect(railway.deploy.startCommand).toBeUndefined();
    expect(railway.deploy.cronSchedule).toBeUndefined();
  });

  test("the Railway README lists the service and points at the onion README", () => {
    const railwayReadme = read("deploy/railway/README.md");
    expect(railwayReadme).toContain("onion.railway.json");
    expect(railwayReadme).toContain("../onion/README.md");
  });
});

describe("the README", () => {
  test("covers the volume, the variables, the steps and the logging promise, without any secret value", () => {
    for (const must of ["/var/lib/tor", "hs_ed25519_secret_key", "ONION_UPSTREAM", "ONION_PROXY_SECRET", "ONION_ADDRESS", "ONION_SINGLE_HOP", "railway ssh", "healthz", "exactly one", "no log"]) expect(readme.toLowerCase()).toContain(must.toLowerCase());
    expect(readme).not.toMatch(/[0-9a-f]{64}/);
    expect(readme).not.toMatch(/\b[a-z2-7]{56}\.onion\b/);
  });
});
