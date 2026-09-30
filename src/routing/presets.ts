import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { presetVersions } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { canonical, canonicalJson, sha256 } from "../lib/util.ts";
import { MAX_ROUTE_MODELS, SLUG_RE, applyRouteConfig, normalizeConfig, routeParamsSchema, routeProviderSchema, type RouteConfig } from "./saved-routes.ts";

// Presets: config-as-code an account calls as `model: "@preset/<name>"` (or `@preset/<name>@<version>` to pin one
// version). A preset is a versioned saved route: the same fallback models, provider preferences (including the
// `provider.lane` / `provider.disclosure` privacy settings, where the stricter of preset and request wins) and sampling
// defaults as `@route/<slug>`, applied by the same code (applyRouteConfig), plus the prompt-side defaults a route may not
// hold: a system prompt, a response_format, and tool definitions with a tool_choice.
//
// Every PUT that changes the preset appends a new, immutable version (1, 2, 3, ...) identified also by the SHA-256 of its
// canonical JSON. Rollback appends a new version with an earlier version's content (so its hash equals that version's);
// nothing is ever rewritten, and a pinned `@preset/<name>@<n>` keeps resolving to the same content until the preset is
// deleted. Stored only in preset_versions, never in saved_routes, whose rows hold no prompt text.
//
// Resolution precedence, highest first (the same as a saved route):
//   1. what the request sets explicitly (`models`, each `provider.*` field, each parameter, `tools`, `response_format`)
//   2. a key's LiteLLM alias that points at the preset
//   3. the preset
//   4. the key's default provider preferences
// System prompt rule: the preset's `system_prompt` is prepended as a `system` message only when the request's `messages`
// has no `system` or `developer` message; a request that brings its own system message keeps it and gets no second one.

export const PRESET_PREFIX = "@preset/";
export const MAX_PRESETS_PER_ACCOUNT = 100;
export const MAX_VERSIONS_PER_PRESET = 100;
export const LIMITS = {
  systemPromptChars: 16_000,
  tools: 32,
  toolDescriptionChars: 1_024,
  responseFormatBytes: 16 * 1024,
  toolsBytes: 32 * 1024,
  presetBytes: 64 * 1024,
} as const;

const NESTED = /^@(route|preset)\//i;
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((m) => !NESTED.test(m), "a preset cannot point to a @route/ or another @preset/");
const models = z
  .array(modelId)
  .min(1, "list at least one model")
  .max(MAX_ROUTE_MODELS, `list at most ${MAX_ROUTE_MODELS} models`)
  .refine((list) => new Set(list).size === list.length, "list each model once");

const jsonObject = z.record(z.string(), z.unknown());
const fnName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, underscores or hyphens");

export const responseFormatSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text") }),
    z.strictObject({ type: z.literal("json_object") }),
    z.strictObject({
      type: z.literal("json_schema"),
      json_schema: z.strictObject({ name: fnName, description: z.string().max(LIMITS.toolDescriptionChars).optional(), strict: z.boolean().optional(), schema: jsonObject }),
    }),
  ])
  .refine((f) => bytes(f) <= LIMITS.responseFormatBytes, `response_format must be at most ${LIMITS.responseFormatBytes / 1024} KB as JSON`);

const toolSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({ name: fnName, description: z.string().max(LIMITS.toolDescriptionChars).optional(), parameters: jsonObject.optional(), strict: z.boolean().optional() }),
});
export const toolsSchema = z
  .array(toolSchema)
  .min(1)
  .max(LIMITS.tools, `list at most ${LIMITS.tools} tools`)
  .refine((list) => new Set(list.map((t) => t.function.name)).size === list.length, "name each tool once")
  .refine((list) => bytes(list) <= LIMITS.toolsBytes, `tools must be at most ${LIMITS.toolsBytes / 1024} KB as JSON`);
const toolChoiceSchema = z.union([z.enum(["none", "auto", "required"]), z.strictObject({ type: z.literal("function"), function: z.strictObject({ name: fnName }) })]);

/** A preset document: what a PUT sends and what each version stores (normalized). The name comes from the URL. */
export const presetDocSchema = z
  .strictObject({
    description: z.string().trim().max(280).optional(),
    models,
    provider: routeProviderSchema.optional(),
    params: routeParamsSchema.optional(),
    system_prompt: z.string().min(1, "leave system_prompt out instead of sending it empty").max(LIMITS.systemPromptChars, `system_prompt must be at most ${LIMITS.systemPromptChars} characters`).optional(),
    response_format: responseFormatSchema.optional(),
    tools: toolsSchema.optional(),
    tool_choice: toolChoiceSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.tool_choice !== undefined && !d.tools) ctx.addIssue({ code: "custom", path: ["tool_choice"], message: "tool_choice needs tools in the same preset" });
    if (d.tool_choice && typeof d.tool_choice === "object" && !d.tools?.some((t) => t.function.name === (d.tool_choice as { function: { name: string } }).function.name))
      ctx.addIssue({ code: "custom", path: ["tool_choice"], message: "tool_choice names a tool the preset does not define" });
    if (bytes(d) > LIMITS.presetBytes) ctx.addIssue({ code: "custom", path: [], message: `a preset must be at most ${LIMITS.presetBytes / 1024} KB as JSON` });
  });
export type PresetDoc = z.infer<typeof presetDocSchema>;

export const rollbackSchema = z.strictObject({ version: z.union([z.number().int().min(1), z.string().trim().min(1).max(64)]) });

/** Drop empty and default values (the same rules as a saved route) so equal presets hash equally. */
export function normalizePreset(doc: PresetDoc): PresetDoc {
  const route = normalizeConfig({ models: doc.models, provider: doc.provider, params: doc.params } as RouteConfig);
  const out: PresetDoc = { ...(doc.description ? { description: doc.description } : {}), ...route };
  if (doc.system_prompt) out.system_prompt = doc.system_prompt;
  if (doc.response_format) out.response_format = doc.response_format;
  if (doc.tools) out.tools = doc.tools;
  if (doc.tool_choice !== undefined) out.tool_choice = doc.tool_choice;
  return canonical(out) as PresetDoc;
}

/** The version hash: SHA-256 of the normalized document's canonical JSON (sorted keys, no whitespace). */
export const presetHash = (doc: PresetDoc) => sha256(canonicalJson(normalizePreset(doc)));

// ---- names and version references -----------------------------------------------------------------

/** `@preset/<name>` or `@preset/<name>@<ref>` -> { name, ref }; anything else -> null. */
export function presetRefOf(model: unknown): { name: string; ref: string | null } | null {
  if (typeof model !== "string" || !model.startsWith(PRESET_PREFIX)) return null;
  const rest = model.slice(PRESET_PREFIX.length);
  const at = rest.indexOf("@");
  return at === -1 ? { name: rest, ref: null } : { name: rest.slice(0, at), ref: rest.slice(at + 1) };
}

/**
 * A version reference: a version number (`3`, `v3`) or a hash prefix of 7 to 64 hex characters. A number of up to six
 * digits is a version number; anything longer is read as a hash prefix. Returns null for anything else.
 */
export function parseVersionRef(ref: string | number): { version: number } | { hash: string } | null {
  const s = String(ref).trim().toLowerCase();
  const n = /^v?(\d{1,6})$/.exec(s);
  if (n) return Number(n[1]) >= 1 ? { version: Number(n[1]) } : null;
  if (/^[0-9a-f]{7,64}$/.test(s)) return { hash: s };
  return null;
}

type VersionRow = typeof presetVersions.$inferSelect;

/** The latest version of a preset, or the one `ref` names (a hash prefix matches the latest version with that content). */
export async function findPresetVersion(db: Db | Tx, accountId: string, name: string, ref: string | number | null = null): Promise<VersionRow | null> {
  if (!SLUG_RE.test(name)) return null;
  const where = [eq(presetVersions.accountId, accountId), eq(presetVersions.name, name)];
  if (ref !== null) {
    const r = parseVersionRef(ref);
    if (!r) return null;
    if ("version" in r) where.push(eq(presetVersions.version, r.version));
    else where.push(sql`${presetVersions.hash} like ${r.hash + "%"}`);
  }
  const [row] = await db.select().from(presetVersions).where(and(...where)).orderBy(desc(presetVersions.version)).limit(1);
  return row ?? null;
}

/** Serialize writes to one account's presets (limits and version numbers are then race-free). */
export async function lockAccountPresets(tx: Tx, accountId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"presets:" + accountId}, 0))`);
}

// ---- diff -----------------------------------------------------------------------------------------

export type Change = { op: "add" | "remove" | "replace"; path: string; from?: unknown; to?: unknown };
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A JSON diff of two documents: JSON Pointer paths with the old and new value (like JSON Patch, plus the old value). */
export function diffJson(a: unknown, b: unknown, path = ""): Change[] {
  if (canonicalJson(a) === canonicalJson(b)) return [];
  if (isObj(a) && isObj(b)) {
    const out: Change[] = [];
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const p = `${path}/${ptr(k)}`;
      if (!(k in b)) out.push({ op: "remove", path: p, from: a[k] });
      else if (!(k in a)) out.push({ op: "add", path: p, to: b[k] });
      else out.push(...diffJson(a[k], b[k], p));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: Change[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= b.length) out.push({ op: "remove", path: `${path}/${i}`, from: a[i] });
      else if (i >= a.length) out.push({ op: "add", path: `${path}/${i}`, to: b[i] });
      else out.push(...diffJson(a[i], b[i], `${path}/${i}`));
    }
    return out;
  }
  return [{ op: "replace", path: path || "/", from: a, to: b }];
}

// ---- applying a preset to a request -----------------------------------------------------------------

const hasSystem = (messages: unknown) => Array.isArray(messages) && messages.some((m) => isObj(m) && (m.role === "system" || m.role === "developer"));

/**
 * Fill a request body in place from a preset. The routing part (models, provider, params, stricter-wins privacy) is the
 * saved route's own applyRouteConfig. Then: `system_prompt` is prepended unless the request already has a `system` or
 * `developer` message; `response_format` and `tools` (with `tool_choice`) fill in only when the request sets none.
 */
export function applyPreset(body: Record<string, unknown>, doc: PresetDoc) {
  applyRouteConfig(body, { models: doc.models, provider: doc.provider, params: doc.params } as RouteConfig);
  if (doc.system_prompt && Array.isArray(body.messages) && !hasSystem(body.messages)) body.messages = [{ role: "system", content: doc.system_prompt }, ...body.messages];
  if (doc.response_format && body.response_format === undefined) body.response_format = structuredClone(doc.response_format);
  if (doc.tools && body.tools === undefined) {
    body.tools = structuredClone(doc.tools);
    if (doc.tool_choice !== undefined && body.tool_choice === undefined) body.tool_choice = structuredClone(doc.tool_choice);
  }
  return body;
}

export type ResolvedPreset = { name: string; version: number; hash: string; models: string[] };

/**
 * Chat/completions hook: when `model` is `@preset/<name>[@<version>]`, load that version of the caller's preset and merge
 * it into the body. Returns what resolved, or null when the request does not name a preset. The legacy completions
 * endpoint has no messages, tools or response_format, so a preset that sets any of them is refused there.
 */
export async function resolvePreset(db: Db, accountId: string | null, body: Record<string, unknown>, kind: "chat" | "completion" | string = "chat"): Promise<ResolvedPreset | null> {
  if (Array.isArray(body.models) && body.models.some((m) => typeof m === "string" && /^@preset\//i.test(m)))
    fail(400, "`models` cannot contain `@preset/` entries; pass a preset as `model`.", "invalid_request");
  const ref = presetRefOf(body.model);
  if (ref === null) return null;
  const shown = `@preset/${ref.name.slice(0, 60)}${ref.ref !== null ? "@" + ref.ref.slice(0, 64) : ""}`;
  if (!accountId) fail(401, `${shown} is a preset: call it with an API key of the account that saved it.`, "missing_key");
  if (ref.ref !== null && !parseVersionRef(ref.ref)) fail(400, `${shown}: a version is a number (3 or v3) or a hash prefix of at least 7 hex characters.`, "invalid_request");
  const row = await findPresetVersion(db, accountId, ref.name, ref.ref);
  if (!row) {
    if (ref.ref !== null && (await findPresetVersion(db, accountId, ref.name)))
      fail(404, `Preset @preset/${ref.name} has no version ${ref.ref.slice(0, 64)}. List them with GET /api/v1/presets/${ref.name}/versions.`, "preset_version_not_found");
    fail(404, `No preset @preset/${ref.name.slice(0, 60)} in this account. List yours with GET /api/v1/presets.`, "preset_not_found");
  }
  const doc = presetDocSchema.safeParse(row.config);
  if (!doc.success) fail(409, `Preset ${shown} no longer validates; save a new version with PUT /api/v1/presets/${row.name}.`, "preset_invalid");
  if (kind !== "chat" && (doc.data.system_prompt || doc.data.tools || doc.data.response_format))
    fail(400, `${shown} sets a system prompt, tools or a response_format, which only /api/v1/chat/completions can carry.`, "preset_unsupported");
  applyPreset(body, doc.data);
  return { name: row.name, version: row.version, hash: row.hash, models: doc.data.models };
}
