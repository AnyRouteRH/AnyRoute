// D142: no additional persistent store, counter family or log fields.
import type { ExternalDoc } from "./types.ts";
export const telegramPhotoReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/telegram/photos.ts", carries: "prompt-or-answer",
  reads: "With TELEGRAM_PHOTOS_ENABLED, the bot reads photo size identifiers and the optional caption from a private Telegram message, calls getFile and downloads the largest photo that fits 8 MB. The downloaded JPEG and caption are readable in router memory for this request.",
  then: "An in-memory JPEG segment filter copies the image data unchanged and drops EXIF and other application metadata, comments and trailing bytes. Malformed or oversized images are refused. The caption, or a fixed question, and an inline JPEG go through the same API-key chat route, billing, limits, private-mode lane guard and signed receipts as text. Telegram and the chosen model provider can read the image and caption and apply their own retention policies.",
  kept: "No photo bytes, caption, file id, download path or image URL are saved in Postgres, Redis, logs, filesystem or a bot history. The request's digest and ordinary billing and receipt metadata are retained by the chat path. The bot never opts into response caching. Existing sealed key, model, private-mode setting, polling offset and Telegram-user rate counter retention are unchanged. Disabled by default; no download while off.",
  evidence: [{ file: "src/telegram/photos.ts", contains: "Buffer.from(reencodePhotoJpeg(bytes))" }, { file: "src/services/telegram.ts", contains: "if (photo) return this.answer(uid, chat, text, photo)" }],
};
