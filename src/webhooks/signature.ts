import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const newSigningSecret = () => `whsec_${randomBytes(32).toString("hex")}`;
export function webhookSignature(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
/** Verify exact wire bytes, then atomically deduplicate the event id at the receiver before effects. */
export function verifyWebhook(secret: string, body: string, header: string, now = Math.floor(Date.now() / 1000)) {
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header);
  if (!match || Math.abs(now - Number(match[1])) > 300) return false;
  return timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(webhookSignature(secret, body, Number(match[1])).split("v1=")[1], "hex"));
}
