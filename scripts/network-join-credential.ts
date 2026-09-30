import { open } from "node:fs/promises";
import { canonicalJson } from "../src/lib/util.ts";

export { canonicalJson };
export type JoinOptions = Record<string, string | boolean>;
export class JoinError extends Error {}
export const reject = (message: string): never => { throw new JoinError(message); };
export const hasCredentialSource = (o: JoinOptions) => !!(o["--api-key-file"] || o["--api-key-env"]);

export function providerId(value: string): string {
  if (!value || value.length > 100) reject("Provide a provider ID with 1 to 100 characters.");
  return value;
}
export const credentialBody = (id: string, apiKey = "<redacted>") => canonicalJson({ provider_id: id, api_key: apiKey });

/** Validate before signup, using the same file handle for permissions and contents. */
export async function readApiKey(o: JoinOptions, env: NodeJS.ProcessEnv, remember: (secret: string) => void): Promise<string> {
  let raw: string;
  if (o["--api-key-file"]) {
    const file = await open(String(o["--api-key-file"]), "r").catch(() => reject("Could not read the sidecar API key file."));
    try {
      const info = await file.stat();
      if (!info.isFile()) reject("The sidecar API key source must be a regular file.");
      if (process.platform !== "win32" && (info.mode & 0o044)) reject("The sidecar API key file must not be group or world readable; use chmod 600.");
      const bytes = await file.readFile();
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return reject("The sidecar API key file must contain UTF-8 text."); }
      finally { bytes.fill(0); }
    } catch (error) {
      if (error instanceof JoinError) throw error;
      return reject("Could not read the sidecar API key file.");
    } finally { await file.close(); }
  } else raw = env[String(o["--api-key-env"])] || "";
  remember(raw);
  const key = raw.trim();
  remember(key);
  if (key.length < 16 || key.length > 500) reject("The sidecar API key must contain 16 to 500 characters after trimming.");
  return key;
}

/** Hide both literal and JSON-escaped credentials in reflected router output. */
export function redactCredentials(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("<redacted>");
    text = text.split(JSON.stringify(secret).slice(1, -1)).join("<redacted>");
  }
  return text;
}
