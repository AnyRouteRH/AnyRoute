import { expect, test } from "bun:test";
import { Queue } from "bullmq";
import { Jobs } from "../src/services/jobs.ts";
test.skipIf(!process.env.TEST_REDIS_URL)("BullMQ records failed processors and succeeds on a subsequent scheduled run", async () => {
  const name = `failure-fixture-${process.pid}`;
  let attempts = 0;
  const jobs = new Jobs(process.env.TEST_REDIS_URL);
  const queue = new Queue("anyroute-jobs-all", { connection: { url: process.env.TEST_REDIS_URL } as never });
  jobs.register(name, 200, async () => { if (++attempts === 1) throw new Error("expected fixture failure"); });
  try {
    await jobs.start();
    const deadline = Date.now() + 5000;
    while (attempts < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect((await queue.getFailed()).some((j) => j.name === name && j.failedReason === "expected fixture failure")).toBe(true);
    expect(jobs.status()[0].last_error).toBeNull();
  } finally { await jobs.stop(); await queue.removeJobScheduler(name); await queue.close(); }
}, 10_000);
