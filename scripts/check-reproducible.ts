// Check that what a pinned dstack compose file commits to can be reproduced by anyone from public sources.
//
//   bun scripts/check-reproducible.ts [--compose sidecar/examples/phala/docker-compose.yml]
//        [--repo <dir>]                 a git checkout that has the pinned commit, for the local `git archive` comparison
//        [--tarball <file>]             use this file as the first download instead of fetching it
//        [--app-compose <file>]         the CVM's app-compose.json (or an attestation document that carries it)
//        [--compose-hash <sha256:..>]   the compose hash the quote committed to (router record, quote event log, bindings)
//        [--offline] [--json]
//
// The compose file pins the sidecar source by commit and by the sha256 of GitHub's tar.gz for that commit; the weights by a
// revision URL and sha256; every image by digest. This script checks, and reports one line each:
//   pins            the file is fully pinned, and the model digest it allows is the one its weights pin implies
//   download        the tarball is downloaded twice from the pinned URL: both hashes equal each other and the pin
//   git archive     with a checkout that has the commit: the uncompressed tar equals `git archive` of that commit, so the
//                   pinned bytes are GitHub's compression of a tree anyone can rebuild (whether the gzip bytes themselves
//                   are reproduced locally depends on the gzip implementation; that is reported, not required)
//   app-compose     with the CVM's app-compose.json: its docker_compose_file is this file byte for byte, and its sha256 is the
//                   compose hash the quote committed to
// Exit status 0 when every check that ran passed, 1 otherwise. Network use is two GETs of the public tarball; --offline
// skips them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { checkPins, parsePins, readAppCompose, type PinCheck } from "./lib/compose-pins.ts";

export type Report = { ok: boolean; checks: (PinCheck & { kind: "required" | "info" })[]; composeSha256: string };
type Deps = { fetch: typeof fetch; out: (s: string) => void; err: (s: string) => void };
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function download(f: typeof fetch, url: string): Promise<Buffer> {
  const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}

function git(dir: string, args: string[]): Buffer | null {
  const r = spawnSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : null;
}

export async function checkReproducible(o: { composeText: string; repoDir?: string; tarballFile?: string; appComposeText?: string; composeHash?: string; offline?: boolean }, deps: Pick<Deps, "fetch">): Promise<Report> {
  const checks: Report["checks"] = [];
  const req = (c: PinCheck) => checks.push({ ...c, kind: "required" });
  const info = (c: PinCheck) => checks.push({ ...c, kind: "info" });
  const pins = parsePins(o.composeText);
  for (const c of checkPins(pins)) req(c);

  if (pins.source) {
    const s = pins.source;
    let first: Buffer | null = null;
    if (o.offline && !o.tarballFile) info({ id: "download", ok: true, detail: "skipped (--offline)" });
    else {
      try {
        first = o.tarballFile ? readFileSync(o.tarballFile) : await download(deps.fetch, s.tarballUrl);
        const a = sha(first);
        req({ id: "download_matches_pin", ok: `sha256:${a}` === s.tarballSha256, detail: `${o.tarballFile ? "file" : "download"} sha256:${a}; pinned ${s.tarballSha256}` });
        if (!o.offline) {
          const second = await download(deps.fetch, s.tarballUrl);
          const b = sha(second);
          req({ id: "download_is_stable", ok: a === b, detail: a === b ? "a second download has the same sha256" : `a second download differs: sha256:${b}` });
        }
      } catch (e) {
        req({ id: "download_matches_pin", ok: false, detail: `could not fetch ${s.tarballUrl}: ${(e as Error).message}` });
      }
    }

    const repoDir = o.repoDir;
    if (repoDir) {
      const has = git(repoDir, ["cat-file", "-e", `${s.commit}^{commit}`]) !== null;
      if (!has) info({ id: "git_archive", ok: false, detail: `${repoDir} does not have commit ${s.commit}` });
      else {
        const prefix = `${s.name}-${s.commit}/`;
        const tar = git(repoDir, ["archive", "--format=tar", `--prefix=${prefix}`, s.commit]);
        if (!tar) info({ id: "git_archive", ok: false, detail: "git archive failed" });
        else if (first) {
          let downloaded: Buffer | null = null;
          try {
            downloaded = gunzipSync(first);
          } catch {
            /* not gzip */
          }
          req({ id: "git_archive_matches_tar", ok: !!downloaded && sha(downloaded) === sha(tar), detail: downloaded ? `uncompressed download sha256:${sha(downloaded)}; git archive sha256:${sha(tar)}` : "the download is not a gzip stream" });
          const gz = git(repoDir, ["archive", "--format=tar.gz", `--prefix=${prefix}`, s.commit]);
          info({ id: "git_archive_gzip_bytes", ok: !!gz && `sha256:${sha(gz)}` === s.tarballSha256, detail: gz ? `local tar.gz sha256:${sha(gz)}${`sha256:${sha(gz)}` === s.tarballSha256 ? " equals the pin" : " differs from the pin (compression is not reproduced by this git/gzip; the tar content above is)"}` : "git archive --format=tar.gz failed" });
        } else info({ id: "git_archive", ok: true, detail: `git archive of ${s.commit} sha256:${sha(tar)} (no download to compare with)` });
      }
    }
  }

  if (o.appComposeText !== undefined) {
    try {
      const app = readAppCompose(o.appComposeText);
      req({ id: "app_compose_embeds_this_file", ok: app.docker_compose_file === o.composeText, detail: app.docker_compose_file === null ? "app-compose has no docker_compose_file" : app.docker_compose_file === o.composeText ? "docker_compose_file is this compose file, byte for byte" : "docker_compose_file differs from this compose file" });
      if (o.composeHash) {
        const want = o.composeHash.replace(/^(?:sha256:|0x)/, "").toLowerCase();
        const which = app.rawSha256 === want ? "the app-compose text as given" : app.sortedSha256 === want ? "the key-sorted app-compose JSON" : null;
        req({ id: "app_compose_hash_matches", ok: !!which, detail: which ? `sha256 of ${which} is the compose hash` : `sha256 of app-compose is sha256:${app.rawSha256} (key-sorted: sha256:${app.sortedSha256}); the quote committed to sha256:${want}` });
      } else info({ id: "app_compose_hash", ok: true, detail: `sha256 of the app-compose text is sha256:${app.rawSha256} (key-sorted: sha256:${app.sortedSha256}); pass --compose-hash to compare` });
    } catch (e) {
      req({ id: "app_compose_embeds_this_file", ok: false, detail: (e as Error).message });
    }
  } else if (o.composeHash) info({ id: "app_compose_hash", ok: true, detail: "no --app-compose given: the compose hash is not compared with anything" });

  return { ok: checks.filter((c) => c.kind === "required").every((c) => c.ok), checks, composeSha256: sha(o.composeText) };
}

export async function main(argv: string[], deps: Deps = { fetch, out: (s) => console.log(s), err: (s) => console.error(s) }): Promise<number> {
  let v;
  try {
    v = parseArgs({
      args: argv,
      options: { compose: { type: "string" }, repo: { type: "string" }, tarball: { type: "string" }, "app-compose": { type: "string" }, "compose-hash": { type: "string" }, offline: { type: "boolean" }, json: { type: "boolean" } },
      allowPositionals: false,
    }).values;
  } catch (e) {
    deps.err(`${(e as Error).message}\nusage: bun scripts/check-reproducible.ts [--compose file] [--repo dir] [--tarball file] [--app-compose file] [--compose-hash sha256:..] [--offline] [--json]`);
    return 2;
  }
  const composeFile = v.compose ?? "sidecar/examples/phala/docker-compose.yml";
  for (const f of [composeFile, v.tarball, v["app-compose"]].filter(Boolean) as string[]) if (!existsSync(f)) return (deps.err(`no such file: ${f}`), 2);
  const report = await checkReproducible(
    { composeText: readFileSync(composeFile, "utf8"), repoDir: v.repo, tarballFile: v.tarball, appComposeText: v["app-compose"] ? readFileSync(v["app-compose"], "utf8") : undefined, composeHash: v["compose-hash"], offline: v.offline },
    deps,
  );
  if (v.json) deps.out(JSON.stringify(report, null, 2));
  else {
    deps.out(`compose file ${composeFile} sha256:${report.composeSha256}`);
    for (const c of report.checks) deps.out(`${c.ok ? "ok  " : c.kind === "info" ? "note" : "FAIL"} ${c.id}: ${c.detail}`);
    deps.out(report.ok ? "reproducible: every check that ran passed" : "NOT reproduced: see the FAIL lines");
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
