// C127
export default function KeyExpiryDocs() {
  return <section id="key-expiry">
    <h2>Keys that expire</h2>
    <p>Open API keys in Keys &amp; limits. When creating a key or editing it with Rename, choose Never, in 1 day, in 7 days, in 30 days, or on a date. A chosen date starts at midnight in your browser’s timezone. Keys with an expiry show the days left; expired keys appear switched off. Choose Change expiry to extend or remove an expired key’s deadline. Expiry controls are hidden for team keys. This browser will be signed out when it expires.</p>
    <p><code>POST /api/v1/keys</code> and <code>PATCH /api/v1/keys/:hash</code> accept <code>expires_at</code> as an ISO date-time or <code>null</code> for no expiry. Leaving it out preserves the existing setting. Key reads return <code>expires_at</code>. Account sub-key creation uses a bearer management key; team creation also allows owner/admin/dev. The existing unauthenticated root-key creation flow stays available. Changes require management or team owner/admin permission; account ownership and team budget checks still apply. Calls with an expired key receive <code>401 key_expired</code>. Expiry does not erase history or change the stored <code>disabled</code> field; a separately disabled key stays off even after its expiry is extended.</p>
  </section>;
}
