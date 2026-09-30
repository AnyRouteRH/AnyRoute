import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { gatewayReport, keyset, signedReceipt, CLAIMS_OK, session } from "./aci-fixtures.ts";
import { aciReportData, jcs, keysetDigest } from "../src/providers/aci.ts";

const suite = "x25519-aes-256-gcm-hkdf-sha256";
const publicHex = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) => (key.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
const publicKey = (hex: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(hex.replace(/^0x/, ""), "hex")]), format: "der", type: "spki" });
const aes = (priv: any, pub: string) => Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: priv, publicKey: publicKey(pub) }), Buffer.alloc(0), Buffer.from("aci.e2ee.v2.x25519"), 32));
const aad = (b: any, headers: Headers, field: string, id?: string) => Buffer.from(jcs({ algo: suite, model: b.model, field, nonce: headers.get("x-e2ee-nonce"), ts: Number(headers.get("x-e2ee-timestamp")), purpose: id === undefined ? "aci.e2ee.request.v2" : "aci.e2ee.response.v2", ...(id === undefined ? {} : { id }) }));
export function standInGateway() {
  const pair = generateKeyPairSync("x25519");
  const ks = keyset(); ks.e2ee_public_keys[0].public_key = publicHex(pair.publicKey);
  const receipts = new Map<string, any>(); const sessions = new Map<string, any>(); const seen = new Set<string>();
  const state = { attack: "", lastBytes: Buffer.alloc(0), lastHeaders: new Headers(), lastPlaintext: "", lastResponse: Buffer.alloc(0), posts: 0 };
  const seal = (text: string, recipient: string, associated: Buffer) => {
    const eph = generateKeyPairSync("x25519"); const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aes(eph.privateKey, recipient), iv); cipher.setAAD(associated);
    return Buffer.concat([Buffer.from(publicHex(eph.publicKey), "hex"), iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString("hex");
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/v1/aci/attestation") {
      const nonce = state.attack === "attestation-replay" ? "ab".repeat(32) : u.searchParams.get("nonce")!;
      const report = gatewayReport(nonce, { keyset: ks });
      const quote = Buffer.from(report.attestation.evidence.quote, "hex"); quote.writeUInt32LE(0x81, 4); report.attestation.evidence.quote = quote.toString("hex");
      return Response.json(report);
    }
    if (u.pathname.startsWith("/v1/aci/receipts/")) {
      const doc = receipts.get(u.pathname.split("/").at(-1)!);
      if (state.attack === "receipt-tamper") return Response.json({ ...doc, model: "other/model" });
      return doc ? Response.json(doc) : new Response(null, { status: 404 });
    }
    if (u.pathname.startsWith("/v1/aci/sessions/")) return Response.json(sessions.get(u.pathname.split("/").at(-1)!));
    if (u.pathname === "/v1/chat/completions") {
      state.posts++; state.lastBytes = Buffer.from(await req.arrayBuffer()); state.lastHeaders = req.headers;
      const body = JSON.parse(state.lastBytes.toString("utf8"));
      const reject = (type: string) => Response.json({ error: { type, message: "Encrypted request refused" } }, { status: 400 });
      if (req.headers.get("x-model-pub-key")?.replace(/^0x/, "") !== ks.e2ee_public_keys[0].public_key) return reject("e2ee_model_key_mismatch");
      const tuple = [req.headers.get("x-client-pub-key"), req.headers.get("x-model-pub-key"), req.headers.get("x-e2ee-nonce")].join(":").toLowerCase();
      if (seen.has(tuple)) return reject("e2ee_replay_detected"); seen.add(tuple);
      try {
        for (const [i, m] of body.messages.entries()) {
          const buf = Buffer.from(m.content, "hex");
          const decipher = createDecipheriv("aes-256-gcm", aes(pair.privateKey, buf.subarray(0, 32).toString("hex")), buf.subarray(32, 44));
          decipher.setAAD(aad(body, req.headers, `messages.${i}.content`)); decipher.setAuthTag(buf.subarray(-16));
          m.content = Buffer.concat([decipher.update(buf.subarray(44, -16)), decipher.final()]).toString("utf8");
        }
      } catch { return reject("e2ee_decryption_failed"); }
      state.lastPlaintext = JSON.stringify(body);
      const id = "chat-e2ee"; const rid = `e2ee-${state.posts}`;
      const recipient = state.attack === "wrong-response-key" ? publicHex(generateKeyPairSync("x25519").publicKey) : req.headers.get("x-client-pub-key")!;
      const kind = body.stream ? "delta" : "message";
      let content = seal("Encrypted reply", recipient, aad(body, req.headers, `choices.0.${kind}.content`, id));
      if (state.attack === "tampered-field") content = content.slice(0, -2) + (content.endsWith("00") ? "01" : "00");
      const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };
      const answer = { id, model: body.model, choices: [{ index: 0, [kind]: { role: "assistant", content, reasoning: seal("Reasoned privately", recipient, aad(body, req.headers, `choices.0.${kind}.reasoning`, id)), reasoning_content: seal("Reasoning content", recipient, aad(body, req.headers, `choices.0.${kind}.reasoning_content`, id)) }, finish_reason: "stop" }], ...(state.attack === "no-usage" || state.attack === "truncate-no-usage" ? {} : { usage }) };
      let response = Buffer.from(body.stream ? `data: ${JSON.stringify(answer)}\n\ndata: [DONE]\n\n` : JSON.stringify(answer));
      const completeResponse = Buffer.from(response);
      if (state.attack.startsWith("truncate") && body.stream) response = Buffer.from(`data: ${JSON.stringify(answer)}\n\n`);
      if (state.attack === "duplicate-chunk" && body.stream) response = Buffer.from(`data: ${JSON.stringify(answer)}\n\n` + response.toString());
      state.lastResponse = response;
      const s = session({ ...CLAIMS_OK, zdr: { status: "asserted" } }, Math.floor(Date.now() / 1000)); sessions.set(s.id, s.doc);
      receipts.set(rid, signedReceipt({ keysetDigest: keysetDigest(ks), receiptId: rid, model: body.model, requestBody: state.lastPlaintext, responseBody: completeResponse, servedAt: Math.floor(Date.now() / 1000), upstream: { result: "verified", required: true, ...(state.attack === "session-claims" ? { session_id: s.id } : { claims: { ...CLAIMS_OK, zdr: { status: "asserted" } } }) } }));
      return new Response(response, { headers: { "content-type": body.stream ? "text/event-stream" : "application/json", "x-e2ee-applied": "true", "x-e2ee-version": "2", "x-e2ee-algo": suite, "x-receipt-id": rid } });
    }
    return new Response(null, { status: 404 });
  } });
  return { server, state, ks, receipts, url: `http://127.0.0.1:${server.port}/v1`, reportData: (nonce: string) => aciReportData(keysetDigest(ks), nonce) };
}
