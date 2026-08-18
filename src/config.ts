import { z } from "zod";

// Every setting comes from the environment. Missing optional services produce
// an explicit "unavailable" state at runtime; they never fake success.

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (d: number) => z.coerce.number().int().default(d);
const num = (d: number) => z.coerce.number().default(d);
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address")
  .optional()
  .or(z.literal("").transform(() => undefined));
const pk = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
  .optional()
  .or(z.literal("").transform(() => undefined));
const opt = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));
