import { hasModelCapability, modelModalities } from "./model-capabilities.js";
// Browser-only image preparation. Only canvas output is attached; source bytes are never sent or kept.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
export const MAX_IMAGE_EDGE = 2048;
export const MAX_IMAGE_BYTES = 192 * 1024;
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;

export const modelInputs = (raw) => modelModalities(raw, "input");
export const readsImages = (model) => hasModelCapability(model, "vision");
export const hasImages = (messages) => (messages || []).some((m) => (m.attachments || []).some((a) => a.kind === "image"));

// Do not silently omit images when switching a conversation or comparing with a text-only model.
export function imageSendError(model, messages) {
  return hasImages(messages) && !readsImages(model) ? `${model?.name || "This model"} does not accept image input. Switch to a vision model to send this conversation.` : "";
}

export function imageSendBlock(lanes, find, attachments = [], truncate = null) {
  for (const lane of lanes) {
    let messages = lane.messages;
    if (truncate !== null) {
      let turn = -1;
      const cut = messages.findIndex((m) => m.role === "user" && ++turn === truncate);
      if (cut >= 0) messages = messages.slice(0, cut);
    }
    const error = imageSendError(find(lane.modelId), [...messages, { attachments }]);
    if (error) return error;
  }
  return "";
}

export function imageDimensions(width, height, maxEdge = MAX_IMAGE_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > MAX_SOURCE_PIXELS) throw new Error("This image is too large to decode safely.");
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function validateImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error("Choose an image up to 8 MB.");
}

export const blobDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error("This file could not be read."));
  reader.onabort = () => reject(new Error("Reading this file was interrupted."));
  reader.readAsDataURL(blob);
});

// createImageBitmap snapshots the default (first) frame of animated images. No animated Image fallback.
export async function prepareImage(file, { decode = (f) => createImageBitmap(f), canvas = () => document.createElement("canvas"), read = blobDataUrl } = {}) {
  validateImage(file);
  const bitmap = await decode(file);
  let surface;
  try {
    let dimensions = imageDimensions(bitmap.width, bitmap.height);
    surface = canvas();
    for (let attempt = 0; attempt < 6; attempt++) {
      surface.width = dimensions.width;
      surface.height = dimensions.height;
      const context = surface.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare images.");
      // JPEG has no transparency; fill before drawing to keep transparent input readable.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, surface.width, surface.height);
      context.drawImage(bitmap, 0, 0, surface.width, surface.height);
      const blob = await new Promise((resolve) => surface.toBlob(resolve, "image/jpeg", 0.86 - Math.min(attempt, 3) * 0.12));
      if (!blob || blob.type !== "image/jpeg") throw new Error("This browser cannot encode images.");
      if (blob.size <= MAX_IMAGE_BYTES) return { kind: "image", name: "image.jpg", url: await read(blob), size: blob.size, width: surface.width, height: surface.height };
      dimensions = imageDimensions(surface.width, surface.height, Math.floor(Math.max(surface.width, surface.height) * 0.7));
    }
    throw new Error("This image could not be reduced to the sending limit.");
  } finally {
    bitmap.close();
    if (surface) surface.width = surface.height = 0;
  }
}

// Only re-encoded inline JPEGs enter the browser history. External URLs and original formats are excluded.
export function storedImages(attachments) {
  return (attachments || []).filter((a) => a.kind === "image" && typeof a.url === "string" && a.url.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 23 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(a.url)).slice(0, 6).map((a) => ({ id: a.id, kind: "image", name: "image.jpg", url: a.url, size: a.size, width: a.width, height: a.height }));
}

// Image output uses the existing chat completion route and its catalogue prices.
export function imageOutput(model) {
  return hasModelCapability(model, "imageOut");
}

export function imageSettings(model, settings, regenerateMode = null) {
  return regenerateMode === null ? settings : { ...settings, imageOut: imageOutput(model) && regenerateMode, audioOut: false };
}

export function imagePrice(raw) {
  const value = raw?.pricing?.image;
  const price = value === undefined || value === null || value === "" ? NaN : Number(value);
  return Number.isFinite(price) && price > 0
    ? `Catalogue: $${price.toLocaleString("en-US", { maximumSignificantDigits: 12 })} per image. Token charges may also apply.`
    : "Per-image price unavailable. Charges follow token usage; a zero image rate does not mean a free image.";
}

export function safeImageUrl(value) {
  if (typeof value !== "string") return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function imageHistoryFields(message) {
  const images = (Array.isArray(message?.images) ? message.images : []).map(safeImageUrl).filter(Boolean).slice(0, 16);
  return images.length ? { images } : {};
}

export function imageFilename(type, index) {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type];
  return ext ? `anyroute-image-${index + 1}.${ext}` : null;
}

/** No API key, cookies or referrer are sent to an image host. */
export async function imageFile(url, index, request = fetch) {
  const safe = safeImageUrl(url);
  if (!safe) throw new Error("This image format is not supported.");
  const res = await request(safe, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error("The image could not be downloaded. Its link may have expired.");
  const blob = await res.blob();
  const name = imageFilename(blob.type, index);
  if (!name) throw new Error("This image format is not supported.");
  if (blob.size > MAX_SOURCE_BYTES) throw new Error("This image is larger than 8 MB.");
  return new File([blob], name, { type: blob.type });
}
