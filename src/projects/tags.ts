import { fail } from "../lib/errors.ts";
import type { Context } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";

// C134: project labels are account metadata, never signed receipt claims.
export const projectInput = z.string().regex(/^[a-zA-Z0-9._-]{1,48}$/, "Project must be 1–48 characters using only letters, numbers, dots, underscores or hyphens.").transform(value => value.toLowerCase());
export const projectQuery = (value: string | undefined) => value === undefined ? undefined : projectInput.parse(value);
const labels = new WeakMap<Context, string | null>();
export function captureProject(c: Context, key: { project?: string | null } | null) {
  const header = c.req.header("x-anyroute-project");
  labels.set(c, header === undefined ? key?.project ?? null : projectInput.parse(header));
}
export const projectFields = (c: Context) => labels.get(c) ? { project: labels.get(c)! } : {};
export const projectJson = (row: { project?: string | null }) => row.project ? { project: row.project } : {};
// Activity sources retain their existing access checks; only calls carry project labels.
export const activityProject = sql`case when kind = 'call' then (select g.project from generations g where g.id = reference) end`;
export const projectActivityFilter = (project: string | undefined) => project === undefined ? sql`true` : sql`${activityProject} = ${project}`;

export function assertProjectLane(c: Context, lane: string) {
  // As with decision tags, reusable labels would contradict this lane's separation between calls.
  if (lane === "unlinkable" && labels.get(c)) fail(400, "Project tags link calls, so the unlinkable lane does not accept them.", "project_unlinkable");
}
