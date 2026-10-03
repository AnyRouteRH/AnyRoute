import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobSnapshot } from "./jobs.ts";
import { log } from "../lib/util.ts";

// Container liveness for worker processes. A watchdog observes the job runner every few seconds
// and refreshes a local heartbeat file only while every registered job keeps ticking on its own
// schedule and none is stuck. The Compose healthcheck (scripts/worker-healthcheck.sh) only reads
// this file: it never boots the application, registers a job or touches the database, so a
// health probe or restart cannot start a second copy of a privileged job.

export const DEFAULT_HEARTBEAT_FILE = "/tmp/anyroute-worker.heartbeat";
export type HeartbeatOptions = { graceMs?: number; maxRunMs?: number };

/** Every job must have started a run within two intervals (plus grace) and no run may exceed maxRunMs. */
export function schedulerHealthy(jobs: JobSnapshot[], runningSince: Map<string, number>, startedAt: number, now: number, opts: HeartbeatOptions = {}) {
  const graceMs = opts.graceMs ?? 120_000;
  const maxRunMs = opts.maxRunMs ?? 15 * 60_000;
  if (!jobs.length) return false;
  for (const job of jobs) {
    if (!(job.every_ms > 0)) return false;
    const since = runningSince.get(job.name);
    if (job.running && since !== undefined && now - since > maxRunMs) return false;
    const lastRun = job.last_run ? Date.parse(job.last_run) : NaN;
    const reference = Number.isFinite(lastRun) ? Math.max(lastRun, startedAt) : startedAt;
    if (!job.running && now - reference > job.every_ms * 2 + graceMs) return false;
  }
  return true;
}

export class WorkerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningSince = new Map<string, number>();
  private healthy: boolean | null = null;
  private readonly startedAt: number;

  constructor(private status: () => JobSnapshot[], readonly file = DEFAULT_HEARTBEAT_FILE, private opts: HeartbeatOptions & { everyMs?: number } = {}, now = Date.now()) {
    this.startedAt = now;
  }

  /** Returns whether the heartbeat was refreshed. */
  tick(now = Date.now()) {
    const jobs = this.status();
    for (const job of jobs) {
      if (job.running) { if (!this.runningSince.has(job.name)) this.runningSince.set(job.name, now); }
      else this.runningSince.delete(job.name);
    }
    const healthy = schedulerHealthy(jobs, this.runningSince, this.startedAt, now, this.opts);
    if (healthy !== this.healthy) {
      if (!healthy) log.warn("worker heartbeat withheld: a job is overdue or stuck", { jobs: jobs.length });
      this.healthy = healthy;
    }
    if (!healthy) return false;
    // A private unpredictable directory prevents another user from planting a symlink.
    const directory = mkdtempSync(join(dirname(this.file), ".anyroute-heartbeat-"));
    try {
      const tmp = join(directory, "heartbeat");
      writeFileSync(tmp, `${Math.floor(now / 1000)}\n`, { mode: 0o644, flag: "wx" });
      renameSync(tmp, this.file);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    return true;
  }

  start() {
    // A restarted container keeps its filesystem: never let a previous process's heartbeat count.
    rmSync(this.file, { force: true });
    this.timer = setInterval(() => { try { this.tick(); } catch { /* the file goes stale and the check fails */ } }, this.opts.everyMs ?? 5_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    rmSync(this.file, { force: true });
  }
}
