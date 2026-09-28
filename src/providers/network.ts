/** Bound untrusted discovery/attestation JSON, including chunked responses. */
export async function boundedJson(response: Response, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Provider response exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Provider response exceeds the size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
