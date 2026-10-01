// Image output uses the existing chat completion route and its catalogue prices.
export function imageOutput(model) {
  return !!model?.outputs?.includes("image");
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
  if (blob.size > 8 * 1024 * 1024) throw new Error("This image is larger than 8 MB.");
  return new File([blob], name, { type: blob.type });
}
