import { setDefaultTimeout } from "bun:test";

process.env.ANYROUTE_ENV ??= "test";

// The one per-test budget for `bun test`, `bun run test:pg` and CI alike. Bun reads no timeout from bunfig.toml, so
// without this a local run got Bun's 5 s while CI passed --timeout 20000. A test that waits on a chain or the network
// for longer says so itself.
setDefaultTimeout(20_000);

// With TEST_PG_URL / TEST_REDIS_URL every harness uses that server. If it is not running, each test would retry it
// until its own timeout and the run would end in dozens of unrelated failures: stop here with one message instead.
const shown = (url: string) => {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
};
const unreachable = (name: string, url: string, error: unknown) =>
  new Error(`${name}=${shown(url)} is not reachable (${(error as Error)?.message ?? error}). Start it (bun run services:up), or unset ${name} to run without it.`);

if (process.env.TEST_PG_URL) {
  const url = process.env.TEST_PG_URL;
  const sql = (await import("postgres")).default(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (error) {
    throw unreachable("TEST_PG_URL", url, error);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
if (process.env.TEST_REDIS_URL) {
  const url = process.env.TEST_REDIS_URL;
  const redis = new (await import("ioredis")).Redis(url, { lazyConnect: true, connectTimeout: 5_000, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  let cause: unknown;
  redis.on("error", (error) => (cause ??= error)); // the socket error, rather than "Connection is closed."
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    throw unreachable("TEST_REDIS_URL", url, cause ?? error);
  } finally {
    redis.disconnect();
  }
}
