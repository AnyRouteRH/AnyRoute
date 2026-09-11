import { log } from "../lib/util.ts";

// Recurring background jobs. In-process (single router) by default; with REDIS_URL each job is
// a BullMQ repeatable job so exactly one replica runs it per tick.

export type JobFn = () => Promise<unknown>;
type JobState = { name: string; everyMs: number; fn: JobFn; running: boolean; atStart: boolean; lastRun?: number; lastError?: string; lastDurationMs?: number; runs: number };

export class Jobs {
  private jobs = new Map<string, JobState>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private bull: { queue: import("bullmq").Queue; worker: import("bullmq").Worker } | null = null;
  private started = false;

  constructor(private redisUrl?: string) {}

  /** atStart: also run once shortly after start (for jobs whose interval is long, e.g. attestation). */
  register(name: string, everyMs: number, fn: JobFn, opts: { atStart?: boolean } = {}) {
    this.jobs.set(name, { name, everyMs, fn, running: false, atStart: !!opts.atStart, runs: 0 });
  }

  async run(name: string) {
    const j = this.jobs.get(name);
    if (!j) throw new Error(`unknown job ${name}`);
    if (j.running) return { skipped: true };
    j.running = true;
    const t = Date.now();
    try {
      const result = await j.fn();
      j.lastError = undefined;
      return result;
    } catch (e) {
      j.lastError = (e as Error).message;
      log.error("job failed", { job: name, error: j.lastError });
      throw e;
    } finally {
      j.running = false;
      j.lastRun = t;
      j.lastDurationMs = Date.now() - t;
      j.runs++;
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    for (const j of this.jobs.values())
      if (j.atStart) {
        const t = setTimeout(() => void this.run(j.name).catch(() => undefined), 1_000);
        t.unref?.();
        this.timers.push(t as unknown as ReturnType<typeof setInterval>);
      }
    if (this.redisUrl) {
      const { Queue, Worker } = await import("bullmq");
      const connection = { url: this.redisUrl } as never;
      const queue = new Queue("anyroute-jobs", { connection });
      for (const j of this.jobs.values())
        await queue.upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name, opts: { removeOnComplete: 100, removeOnFail: 100 } });
      const worker = new Worker("anyroute-jobs", async (job) => this.run(job.name).catch(() => undefined), { connection, concurrency: 4 });
      this.bull = { queue, worker };
      log.info("jobs started (bullmq)", { jobs: [...this.jobs.keys()] });
      return;
    }
    for (const j of this.jobs.values()) {
      const t = setInterval(() => void this.run(j.name).catch(() => undefined), j.everyMs);
      t.unref?.();
      this.timers.push(t);
    }
    log.info("jobs started (in-process)", { jobs: [...this.jobs.keys()] });
  }

  status() {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      every_ms: j.everyMs,
      running: j.running,
      runs: j.runs,
      last_run: j.lastRun ? new Date(j.lastRun).toISOString() : null,
      last_duration_ms: j.lastDurationMs ?? null,
      last_error: j.lastError ?? null,
    }));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.bull) {
      await this.bull.worker.close();
      await this.bull.queue.close();
    }
    const deadline = Date.now() + 10_000;
    while ([...this.jobs.values()].some((j) => j.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}
