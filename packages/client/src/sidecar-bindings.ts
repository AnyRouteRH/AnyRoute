/** Additional members committed by /attest's SHA-256 bindings format, distinct from SEAL's SHA-512 format. */
export type SidecarBindingsV2 = {
  v: 2;
  source_hash: string;
  engine: { name: string; image_digest: string };
  model: { id: string; digest: string };
};

const digest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
const name = (v: unknown): v is string => typeof v === "string" && v.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Absence of v means legacy v1. Never interpret unversioned extension fields as v2. */
export function validSidecarBindingVersion(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.v === undefined || value.v === 1) return !["source_hash", "engine", "model"].some(k => k in value);
  return value.v === 2 && digest(value.source_hash)
    && object(value.engine) && name(value.engine.name) && digest(value.engine.image_digest)
    && object(value.model) && name(value.model.id) && digest(value.model.digest)
    && value.model.digest === value.model_digest;
}

export function sidecarBindingsV2(value: unknown): SidecarBindingsV2 | null {
  return object(value) && value.v === 2 && validSidecarBindingVersion(value) ? value as unknown as SidecarBindingsV2 : null;
}
