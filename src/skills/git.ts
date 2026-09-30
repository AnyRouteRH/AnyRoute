import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveError, type Limits, type SkillFile } from "./archive.ts";

// Fetch one commit of a git repository and read its tree without checking it out: `git fetch --depth 1` into an empty
// repository, `git ls-tree` for paths, modes and sizes, then `git cat-file --batch` for the blobs. Nothing from the repository
// is written to the working tree, so hooks, filters, LFS smudging and symlinks never act on the machine. Only https is
// allowed (and file:// or a local path when allowLocal, for tests and local mirrors); the host must not be a private address.

export type GitSource = { url: string; ref?: string | null };
export type GitResult = { files: SkillFile[]; commit: string };
export type GitOptions = Limits & { allowLocal: boolean; timeoutMs: number };

const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,128}$/;

function assertUrl(url: string, allowLocal: boolean) {
  if (url.length > 512 || /\s/.test(url) || url.startsWith("-")) throw new ArchiveError("Invalid git URL.");
  if (allowLocal && (url.startsWith("file://") || url.startsWith("/"))) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ArchiveError("Invalid git URL.");
  }
  if (u.protocol !== "https:") throw new ArchiveError("Only https:// git URLs can be imported.");
  if (u.username || u.password) throw new ArchiveError("Git URLs with credentials are not accepted.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !allowLocal &&
    (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(h) ||
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
      /^(::1?|f[cd][0-9a-f]{2}:.*|fe80:.*)$/.test(h) ||
      /^\d+$/.test(h))
  )
    throw new ArchiveError("Git URLs must point at a public host.");
}

async function run(args: string[], opts: { cwd?: string; timeoutMs: number; input?: string; allowLocal: boolean }): Promise<Uint8Array> {
  const protocols = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(opts.allowLocal ? ["-c", "protocol.file.allow=always"] : [])];
  const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...protocols, ...args], {
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_LFS_SKIP_SMUDGE: "1", HOME: opts.cwd ?? tmpdir(), LANG: "C" },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  const [out, , code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new ArchiveError(`git ${args[0]} failed${proc.signalCode ? " (timed out)" : ""}. Check the URL and ref.`);
  return new Uint8Array(out);
}

/** Every file of the repository at `ref` (default: the remote HEAD), within the limits. */
export async function fetchGitTree(src: GitSource, opts: GitOptions): Promise<GitResult> {
  assertUrl(src.url, opts.allowLocal);
  const ref = src.ref?.trim() || "HEAD";
  if (!REF_RE.test(ref)) throw new ArchiveError("Invalid git ref.");
  const dir = await mkdtemp(join(tmpdir(), "anyroute-skill-"));
  try {
    const o = { cwd: dir, timeoutMs: opts.timeoutMs, allowLocal: opts.allowLocal };
    await run(["init", "-q", "--bare"], o);
    await run(["fetch", "-q", "--depth", "1", "--no-tags", "--", src.url, ref], o);
    const commit = new TextDecoder().decode(await run(["rev-parse", "FETCH_HEAD^{commit}"], o)).trim();
    const listing = new TextDecoder().decode(await run(["ls-tree", "-r", "-l", "-z", "--full-tree", commit], o));
    const entries: { mode: string; type: string; sha: string; size: number; path: string }[] = [];
    let total = 0;
    for (const rec of listing.split("\0")) {
      if (!rec) continue;
      const m = rec.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/);
      if (!m) continue;
      if (m[2] !== "blob") continue; // submodules (commit entries) are not fetched
      const size = m[4] === "-" ? 0 : Number(m[4]);
      if (/(^|\/)\.git\//.test(m[5])) continue;
      total += size;
      entries.push({ mode: m[1], type: m[2], sha: m[3], size, path: m[5] });
    }
    return { commit, files: await readBlobs(entries, total, o, opts) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readBlobs(entries: { mode: string; sha: string; size: number; path: string }[], total: number, o: { cwd: string; timeoutMs: number; allowLocal: boolean }, limits: Limits): Promise<SkillFile[]> {
  // The caller picks a skill folder out of the repository afterwards, so the repository as a whole may be larger than one skill;
  // it is still capped (eight skills' worth) so a huge repository is refused before any blob is read.
  if (total > limits.maxBytes * 8 || entries.length > limits.maxFiles * 8) throw new ArchiveError("The repository is too large to import. Point at a smaller repository or a single skill.");
  if (!entries.length) return [];
  const out = await run(["cat-file", "--batch"], { ...o, input: entries.map((e) => e.sha).join("\n") + "\n" });
  const files: SkillFile[] = [];
  let p = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, p);
    const header = new TextDecoder().decode(out.subarray(p, nl));
    const size = Number(header.split(" ")[2]);
    if (!header.startsWith(e.sha) || !Number.isFinite(size)) throw new ArchiveError("Unexpected git cat-file output.");
    const data = out.slice(nl + 1, nl + 1 + size);
    p = nl + 1 + size + 1;
    const mode = parseInt(e.mode, 8);
    if (e.mode === "120000") files.push({ path: e.path, type: "symlink", mode: 0o777, data, target: new TextDecoder().decode(data) });
    else files.push({ path: e.path, type: "file", mode: mode & 0o777, data });
  }
  return files;
}
