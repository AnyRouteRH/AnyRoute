// C131
export default function NewModelsDocs() {
  return <section id="new-models">
    <h2>New models this week</h2>
    <p>Find recently added models in the catalogue, on Home and in Chat. The New badge and New this week filter cover the last seven days. Subscribe to the <a href="/api/v1/models/new.atom">new models feed</a> for additions from the last 30 days.</p>
    <p><code>GET /api/v1/models</code> and <code>GET /v1/models</code> add <code>added_at</code> (Unix seconds) when <code>MODEL_ARRIVALS_ENABLED</code> is enabled; it defaults to false. The existing <code>created</code> field is unchanged. The first refresh seeds existing models with an unknown arrival date (<code>null</code>), so they are not marked new. Later model IDs keep their first observation date, even if removed and reintroduced. The public <code>GET /api/v1/models/new.atom</code> feed needs no key, caches for 30 seconds and is empty when the flag is off. Arrival means first observed in this router’s catalogue, not a model’s release date.</p>
  </section>;
}
