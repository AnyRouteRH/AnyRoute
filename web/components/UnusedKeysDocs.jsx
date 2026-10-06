// B125
export default function UnusedKeysDocs() {
  return <section id="unused-keys">
    <h2>Review unused keys</h2>
    <p>Open API keys in the Keys &amp; limits tab to see when each key was last used. Review enabled keys unused for at least 30 days, select the ones you no longer need, and confirm once to switch them off. A key that has never been used appears after 30 days from creation. This browser's key is excluded. Management keys follow the same rules as other visible keys.</p>
    <p>The list uses <code>GET /api/v1/keys</code> fields <code>last_used</code>, <code>created_at</code> and <code>disabled</code>; the current key comes from <code>GET /api/v1/key</code>. Last used records a charged call, not account browsing or failed or free calls. <code>DELETE /api/v1/keys/:hash</code> switches off each selected key without deleting its history. A bearer management key or team owner/admin key is required to switch keys off; team keys stay within the caller's existing access. Team keys keep their normal audit entries. Account keys do not currently create key-disable entries in Activity. Each change is separate; any failures are shown so you can review them.</p>
  </section>;
}
