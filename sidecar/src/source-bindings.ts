import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeDigest, SidecarError } from "./util.ts";

export type SidecarBindingsV2 = { v: 2; source_hash: string; engine: { name: string; image_digest: string }; model: { id: string; digest: string } };

export type SourceBindingsConfig = {
  version: 2;
  sourceArchive: string;
  sourceHash: string;
  engine: { name: string; image_digest: string };
  modelId: string;
};

/** SHA-256 of the exact archive bytes, including compression headers; no extraction or reserialization. */
export async function sourceArchiveHash(path: string): Promise<string> {
  const h = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) h.update(chunk);
  } catch {
    throw new SidecarError("SOURCE_UNREADABLE", "cannot read bindings.source_archive");
  }
  return `sha256:${h.digest("hex")}`;
}

export async function measureSourceBindings(cfg: SourceBindingsConfig | undefined, modelDigest: string): Promise<SidecarBindingsV2 | undefined> {
  if (!cfg) return undefined;
  const sourceHash = await sourceArchiveHash(cfg.sourceArchive);
  if (sourceHash !== normalizeDigest(cfg.sourceHash, "bindings.source_hash")) {
    throw new SidecarError("SOURCE_HASH_MISMATCH", "bindings.source_hash does not match the pinned source archive; refusing to start");
  }
  return { v: 2, source_hash: sourceHash, engine: cfg.engine, model: { id: cfg.modelId, digest: modelDigest } };
}

export function parseSourceBindings(raw: unknown, servedName?: string): SourceBindingsConfig | undefined {
  if (raw === undefined) return undefined;
  const bad = (message: string): never => { throw new SidecarError("BAD_CONFIG", `sidecar.yaml: bindings: ${message}`); };
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : bad("expected a mapping");
  const known = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).some(k => !keys.includes(k))) bad("unknown setting"); };
  const text = (v: unknown): string => typeof v === "string" && v.trim() ? v.trim() : bad("required string is missing");
  const name = (v: unknown): string => {
    const s = text(v);
    return s.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(s) ? s : bad("invalid engine name or model ID");
  };
  const b = obj(raw);
  known(b, ["version", "source_archive", "source_hash", "engine", "model_id"]);
  if (b.version !== 2) bad("version must be 2; omit bindings for legacy v1");
  const engine = obj(b.engine);
  known(engine, ["name", "image_digest"]);
  const modelId = name(b.model_id);
  if (!servedName || modelId !== servedName) bad("model_id must equal model.served_name");
  return { version: 2, sourceArchive: text(b.source_archive), sourceHash: normalizeDigest(text(b.source_hash), "bindings.source_hash"),
    engine: { name: name(engine.name), image_digest: normalizeDigest(text(engine.image_digest), "bindings.engine.image_digest") }, modelId };
}
