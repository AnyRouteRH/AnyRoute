export type CapabilityKey = "vision" | "imageOut" | "audio" | "tools" | "longContext" | "attested" | "network" | "encrypted";
export type CapabilityTag = { key: CapabilityKey; label: string; explanation: string; href?: string };
export const LONG_CONTEXT_TOKENS: number;
export const MODEL_CAPABILITIES: CapabilityTag[];
export function modelModalities(model: unknown, direction?: "input" | "output"): string[];
export function deriveCapabilities(model?: unknown): CapabilityKey[];
export function modelCapabilities(model?: unknown): CapabilityKey[];
export function hasModelCapability(model: unknown, key: CapabilityKey): boolean;
