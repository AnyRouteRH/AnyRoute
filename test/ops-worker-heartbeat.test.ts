import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JobSnapshot } from "../src/services/jobs.ts";
import { schedulerHealthy, WorkerHeartbeat } from "../src/services/worker-heartbeat.ts";

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const job = (name: string, everyMs: number, lastRun: number | null, running = false): JobSnapshot => ({
  name, every_ms: everyMs, running, runs: lastRun ? 1 : 0, last_run: lastRun ? new Date(lastRun).toISOString() : null,
  last_duration_ms: null, last_error: null, last_success: lastRun ? new Date(lastRun).toISOString() : null,
});
const script = resolve(import.meta.dir, "../scripts/worker-healthcheck.sh");

describe("worker scheduler watchdog", () => {
  test("healthy while every job ticks within two intervals plus grace", () => {
    const jobs = [job("health-flush", 5_000, T0 - 4_000), job("settlement", 3_600_000, T0 - 3_000_000)];
    expect(schedulerHealthy(jobs, new Map(), T0 - 600_000, T0)).toBe(true);
  });
  test("an overdue job withholds the heartbeat, even if other jobs tick", () => {
    const jobs = [job("health-flush", 5_000, T0 - 1_000), job("holds-expire", 60_000, T0 - 400_000)];
    expect(schedulerHealthy(jobs, new Map(), T0 - 3_600_000, T0)).toBe(false);
  });
  test("a job that has not run yet is measured from process start", () => {
    const jobs = [job("slasher", 3_600_000, null)];
    expect(schedulerHealthy(jobs, new Map(), T0 - 3_600_000, T0)).toBe(true);
    expect(schedulerHealthy(jobs, new Map(), T0 - 8_000_000, T0)).toBe(false);
  });
  test("a stuck run is unhealthy after the maximum run time, a long legitimate run is not", () => {
    const running = [job("settlement", 3_600_000, T0 - 7_300_000, true)];
    expect(schedulerHealthy(running, new Map([["settlement", T0 - 60_000]]), T0 - 7_300_000, T0)).toBe(true);
    expect(schedulerHealthy(running, new Map([["settlement", T0 - 16 * 60_000]]), T0 - 7_300_000, T0)).toBe(false);
  });
  test("a worker with no registered jobs is never healthy", () => {
    expect(schedulerHealthy([], new Map(), T0, T0)).toBe(false);
  });
});

describe("worker heartbeat file and container healthcheck", () => {
  const check = (file: string) => Bun.spawnSync(["sh", script], { env: { PATH: process.env.PATH!, WORKER_HEARTBEAT_FILE: file } }).exitCode;

  test("a restarted worker discards the previous heartbeat and only writes while healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "anyroute-heartbeat-"));
    try {
      const file = join(dir, "heartbeat");
      writeFileSync(file, `${Math.floor(Date.now() / 1000)}\n`); // left behind by the previous process
      let jobs = [job("health-flush", 5_000, null)];
      const beat = new WorkerHeartbeat(() => jobs, file, { everyMs: 60_000 }, Date.now());
      beat.start();
      expect(existsSync(file)).toBe(false);
      expect(check(file)).toBe(1);
      expect(beat.tick()).toBe(true);
      expect(check(file)).toBe(0);
      // Overdue: the file is left to go stale instead of being refreshed.
      jobs = [job("health-flush", 5_000, Date.now() - 600_000)];
      rmSync(file);
      expect(beat.tick(Date.now() + 600_000)).toBe(false);
      expect(existsSync(file)).toBe(false);
      jobs = [job("health-flush", 5_000, Date.now())];
      expect(beat.tick()).toBe(true);
      beat.stop();
      expect(existsSync(file)).toBe(false); // a stopping worker reports unhealthy
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the healthcheck accepts only a fresh numeric heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "anyroute-heartbeat-"));
    try {
      const file = join(dir, "heartbeat");
      const now = Math.floor(Date.now() / 1000);
      expect(check(file)).toBe(1);
      writeFileSync(file, `${now - 5}\n`);
      expect(check(file)).toBe(0);
      writeFileSync(file, `${now - 120}\n`);
      expect(check(file)).toBe(1);
      writeFileSync(file, "$(touch pwned)\n");
      expect(check(file)).toBe(1);
      writeFileSync(file, `${now + 3600}\n`);
      expect(check(file)).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the healthcheck is read-only: it cannot start the app or a job", () => {
    const body = readFileSync(script, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(body).not.toMatch(/\bbun\b|\bnode\b|src\/|psql|redis|curl|wget|\beval\b/);
    const worker = readFileSync(resolve(import.meta.dir, "../src/worker.ts"), "utf8");
    expect(worker).toContain("heartbeat.start()");
    expect(worker).toContain("heartbeat.stop()");
  });
});
