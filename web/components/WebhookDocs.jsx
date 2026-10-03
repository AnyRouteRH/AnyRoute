import { Code } from './UI';
export const typescriptVerification = `import { createHmac, timingSafeEqual } from 'node:crypto';
// rawBody is a Buffer of the original HTTP body, before JSON parsing.
function verify(secret: string, rawBody: Buffer, signature: string,
                eventId: string, now = Math.floor(Date.now() / 1000)) {
  const m = /^t=(\\d{1,12}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!m || Math.abs(now - Number(m[1])) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(m[1] + '.').update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(m[2], 'hex'))) return false;
  try { return JSON.parse(rawBody.toString('utf8')).event_id === eventId; }
  catch { return false; }
}
// Read x-anyroute-signature and x-anyroute-event-id; verify first.
// Then atomically claim eventId in durable storage before side effects.
// A repeated ID returns success without repeating the side effects.
// Keep processed IDs for at least 90 days; use an outbox for effects.`;
export const pythonVerification = `import hashlib, hmac, json, re, time

def verify(secret, raw_body, signature, event_id, now=None):
    # raw_body: exact received bytes, before decoding or JSON parsing.
    now = int(time.time()) if now is None else now
    m = re.fullmatch(r"t=(\\d{1,12}),v1=([a-f0-9]{64})", signature)
    if not m or abs(now - int(m[1])) > 300:
        return False
    expected = hmac.new(secret.encode(), m[1].encode() + b"." + raw_body,
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, m[2]):
        return False
    try:
        return json.loads(raw_body)["event_id"] == event_id
    except (ValueError, KeyError, TypeError):
        return False

# After verification, atomically claim event_id in durable storage.
# Keep processed IDs for at least 90 days, and use an outbox for effects.
# Return success for repeated IDs without repeating their effects.`;
export default function WebhookDocs() {
  return <section id="signed-webhooks"><h3>Sign account webhooks</h3>
    <p><code>WEBHOOK_SIGNING_ENABLED</code> defaults to false. Signed webhooks are switched on at anyroute.tech. When enabled, <a href="/dashboard/webhooks/">Webhooks in your account</a> manages destinations, events, rotation, revocation and the last 100 delivery attempts. An account management key adds destinations. Owner/admin keys outside agent sessions can manage linked destinations scoped to their own key. The disabled flag preserves existing alert behaviour.</p>
    <p>New destinations receive a random secret shown once on creation; rotation reveals a replacement once. The router stores it encrypted under APP_SECRET and reads it in memory to sign notices. Existing destinations remain unsigned until rotated. Revocation removes the credential and stops future delivery; a request already in flight can finish. Keep the receiver’s secret outside source code. URLs use guarded HTTPS egress with public DNS answers pinned and redirects refused.</p>
    <p>Each enabled delivery carries <code>x-anyroute-event-id</code>. Signed deliveries also carry <code>x-anyroute-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where v1 is HMAC-SHA256 using the literal secret string over timestamp, a period and the exact body bytes. Signed bodies include <code>event_id</code> matching the header. Verify before parsing or processing, reject timestamps more than five minutes in either direction, compare in constant time, and atomically reject duplicate event IDs. Retries keep the event ID and receive a fresh timestamp/signature.</p>
    <p>Subscribe to spending and agent alerts, approval requests and decisions, credited deposits, funded/disputed/ruled agreements, observed status changes of hosts your account operates, and issued make-good refunds (<code>refund.issued</code>, queued with the refund when <code>MAKEGOOD_ENABLED</code> is on; reference: the refund id, status: the rule). New notices contain only id, type, source reference, time and fixed status; linked spending and agent alerts retain their existing fields with event_id added when signed. Approval references name the approval record. No prompt or answer text is included. Event availability follows the source feature flags.</p>
    <p>The minute worker reads 50 destinations per tick, one activity page per destination, and sends at most 100 notices per tick. Creation sets the lower time bound; durable pagination and five minutes of overlap catch ordinary late commits. Source deletion before discovery or commits delayed beyond that overlap can lose notices. Approval requests/decisions and operated host status changes are queued when the router records them, in the same transaction. Changes between worker ticks are retained. Direct database writes outside those router writers do not create notices. Three delivery attempts are separated by five minutes. Delivery metadata stays for 90 days, with no bodies stored. A stopped worker delays delivery. A crash after sending can repeat a notice.</p>
    <p>Use GET/POST /api/v1/webhooks, PATCH/DELETE /api/v1/webhooks/&#123;id&#125;, POST /rotate or /revoke, GET /deliveries and POST /test under that destination path. The endpoint check is queued, limited to one per minute and sent even if no event subscription matches. Removing a linked destination requires removing its URL in Spend Watch; revocation can stop it here.</p>
    <Code label="TypeScript verification">{typescriptVerification}</Code><Code label="Python verification">{pythonVerification}</Code>
  </section>;
}
