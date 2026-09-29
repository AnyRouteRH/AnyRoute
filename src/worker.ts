import { createApp } from "./app.ts";
import { DEFAULT_HEARTBEAT_FILE, WorkerHeartbeat } from "./services/worker-heartbeat.ts";
const { ctx, close } = await createApp();
if (ctx.cfg.runtimeRole !== "worker") { await close(); throw new Error("Worker entrypoint requires RUNTIME_ROLE=worker."); }
// In-process timers are unref'd; keep the worker alive independently of queue transports.
const keepAlive = setInterval(() => {}, 60_000);
// Liveness for container healthchecks: refreshed only while registered jobs tick on schedule.
const heartbeat = new WorkerHeartbeat(() => ctx.jobs.status(), process.env.WORKER_HEARTBEAT_FILE || DEFAULT_HEARTBEAT_FILE);
heartbeat.start();
let stopping = false;
async function stop() { if (stopping) return; stopping = true; heartbeat.stop(); clearInterval(keepAlive); await close(); process.exit(0); }
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
