import { expect, test } from "bun:test";
import { Queue } from "bullmq";
import { Jobs } from "../src/services/jobs.ts";

test("in-process jobs run on schedule, never overlap, and report status", async () => {
  const j = new Jobs();
  let runs = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  j.register("tick", 30, async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await Bun.sleep(50);
    concurrent--;
    runs++;
  });
  await j.start();
  await Bun.sleep(400);
  await j.stop();
  expect(runs).toBeGreaterThan(2);
  expect(maxConcurrent).toBe(1);
  expect(j.status()[0].runs).toBe(runs);
});

test.skipIf(!process.env.TEST_REDIS_URL)("BullMQ: two replicas share one schedule; each tick runs once", async () => {
  const counts: Record<string, number> = { a: 0, b: 0 };
  const mk = (name: string) => {
    const j = new Jobs(process.env.TEST_REDIS_URL);
    j.register("bull-tick-" + process.pid, 200, async () => void counts[name]++);
    return j;
  };
  const a = mk("a");
  const b = mk("b");
  try {
    await a.start();
    await b.start();
    await Bun.sleep(1500);
  } finally {
    await a.stop();
    await b.stop();
    // The schedule lives in Redis and outlives this process: remove it, or every later run on the same Redis
    // finds this run's leftover schedule competing for the queue and counts fewer ticks.
    const queue = new Queue("anyroute-jobs-all", { connection: { url: process.env.TEST_REDIS_URL } as never });
    await queue.removeJobScheduler("bull-tick-" + process.pid);
    await queue.close();
  }
  const total = counts.a + counts.b;
  expect(total).toBeGreaterThanOrEqual(4);
  expect(total).toBeLessThanOrEqual(9); // ~1500/200 ticks, not doubled by two replicas
}, 20_000);
