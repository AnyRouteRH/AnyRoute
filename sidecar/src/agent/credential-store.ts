import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { hash } from "./bindings.ts";
/** Domain separation includes the measured compose hash; GetKey itself is scoped to the dstack app identity. */
export async function deriveSealingKey(socket: string, composeHash: string, fetchImpl: typeof fetch = fetch) {
  if (!/^sha256:[0-9a-f]{64}$/.test(composeHash) || !socket.startsWith("/")) throw new Error("A measured compose hash and guest socket are required.");
  const res = await fetchImpl("http://dstack/GetKey", {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
    body: JSON.stringify({ path: `anyroute/sealed-agent/v1/${composeHash}/aes-256-gcm`, purpose: "agent credential sealing" }),
    unix: socket, signal: AbortSignal.timeout(15_000),
  } as RequestInit & { unix: string });
  if (!res.ok) throw new Error("Guest key derivation failed.");
  const value = await res.json() as { key?: string };
  if (!value.key || !/^[0-9a-fA-F]{64}$/.test(value.key)) throw new Error("Guest returned an invalid sealing key.");
  return Buffer.from(value.key, "hex");
}
const aad = (compose: string) => Buffer.from(`anyroute/sealed-agent/1:${compose}`);
export function sealCredential(key: Buffer, compose: string, secret: string) {
  if (!secret || secret.length > 512 || /\s/.test(secret)) throw new Error("Invalid API credential.");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(compose));
  return Buffer.concat([iv, cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
}
export function openCredential(key: Buffer, compose: string, sealed: Buffer, fingerprint: string) {
  if (sealed.length < 29 || sealed.length > 540) throw new Error("Invalid sealed credential.");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAAD(aad(compose)); decipher.setAuthTag(sealed.subarray(-16));
  const secret = Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]).toString("utf8");
  if (hash(secret) !== fingerprint) throw new Error("Credential fingerprint mismatch.");
  return secret;
}
export async function persistCredential(file: string, sealed: Buffer) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, sealed, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
export const readCredential = (file: string) => readFile(file);
