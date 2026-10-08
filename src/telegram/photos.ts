// D142: Telegram photo input shares the bot's existing authenticated chat path.
import { hasModelCapability } from "../catalog/model-capabilities.js";
import { MAX_PHOTO_BYTES, reencodePhotoJpeg } from "./photo-jpeg.ts";
export { MAX_PHOTO_BYTES };
export type TgPhoto = { file_id: string; width: number; height: number; file_size?: number };
export type PhotoMessage = { photo?: TgPhoto[]; caption?: string };
export const PHOTO_HELP = "Send a photo up to 8 MB, with an optional caption, after choosing a model that reads images with /model. Anyroute reads the photo and caption in memory and sends them to your model provider. EXIF and other metadata are removed from photos, which are not saved by the bot or router. Telegram keeps messages under its own policy; providers follow their own retention policy.";
export const photoCapability = (model: unknown) => ({ vision: hasModelCapability(model, "vision") });
export const hasPhoto = (m: PhotoMessage) => Array.isArray(m.photo) && m.photo.length > 0;
export const photoCaption = (m: PhotoMessage) => m.caption?.trim() || "What is in this picture?";
export function visionReply(model: string, models: { id: string; vision?: boolean }[]) {
  const choices = models.filter((x) => x.vision).slice(0, 3).map((x) => x.id);
  return `${model} can't read images. ${choices.length ? `Try ${choices.join(", ")}. Switch with /model followed by the model name, then send the photo again.` : "No model that reads images is available in this lane right now. Use /models to check again later."}`;
}
export class PhotoError extends Error {}
const fail = (text: string): never => { throw new PhotoError(text); };
const tooBig = () => fail("This photo is larger than 8 MB. Send a smaller photo.");
const unavailable = () => fail("I couldn't download that photo. Please send it again.");
const fits = (size: unknown) => size === undefined || (typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= MAX_PHOTO_BYTES);

/** Strict Telegram-origin download; the token-bearing URL and raw error are never logged. */
async function download(token: string, path: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some((x) => x === "." || x === "..")) unavailable();
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`, { signal: AbortSignal.timeout(30_000), redirect: "error", credentials: "omit" });
  } catch { return unavailable(); }
  if (!res.ok || !res.body) { await res.body?.cancel(); return unavailable(); }
  const length = res.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PHOTO_BYTES)) { await res.body.cancel(); return tooBig(); }
  const reader = res.body.getReader();
  // A fixed bound prevents a server with absent/wrong Content-Length from growing memory.
  const bytes = new Uint8Array(MAX_PHOTO_BYTES);
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.length > MAX_PHOTO_BYTES) { await reader.cancel(); return tooBig(); }
      bytes.set(part.value, size); size += part.value.length;
    }
  } catch (e) { if (e instanceof PhotoError) throw e; return unavailable(); }
  finally { reader.releaseLock(); }
  if (!size) return unavailable();
  return bytes.subarray(0, size);
}

export async function prepareTelegramPhoto(photos: TgPhoto[], opts: { token: string; fetch?: typeof fetch; getFile: (id: string) => Promise<{ file_path?: string; file_size?: number }> }): Promise<string> {
  // Largest pixel dimensions first; Telegram need not order its sizes. Unknown sizes
  // are checked by getFile and by the bounded stream. Oversized candidates fall back.
  const sizes = photos.filter((x) => typeof x.file_id === "string" && Number.isSafeInteger(x.width) && Number.isSafeInteger(x.height) && x.width > 0 && x.height > 0 && fits(x.file_size))
    .sort((a, b) => b.width * b.height - a.width * a.height || (b.file_size ?? 0) - (a.file_size ?? 0));
  if (!sizes.length) return tooBig();
  for (const photo of sizes) {
    let file: { file_path?: string; file_size?: number };
    try { file = await opts.getFile(photo.file_id); } catch { return unavailable(); }
    if (!fits(file?.file_size)) continue;
    if (typeof file?.file_path !== "string") return unavailable();
    let bytes: Uint8Array;
    try { bytes = await download(opts.token, file.file_path, opts.fetch ?? fetch); }
    catch (e) { if (e instanceof PhotoError && e.message.includes("8 MB")) continue; throw e; }
    try { return `data:image/jpeg;base64,${Buffer.from(reencodePhotoJpeg(bytes)).toString("base64")}`; }
    catch { return fail("This photo could not be prepared. Send it again as a JPEG photo."); }
  }
  return tooBig();
}
