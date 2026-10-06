// B117
export default function StopUntilDocs() {
  return <section id="stop-until"><h2>Stop for a while</h2>
    <p>Stop an agent for one hour, until tomorrow at 9:00 in your local time, or until you resume it. New requests through Anyroute are refused during the stop. Requests already running may finish. After a timed stop ends, the next request resumes the agent and its other rules still apply. Keys following a playbook work the same way.</p>
    <p>POST /api/v1/agents/:key_hash/kill accepts an optional until, an ISO time with a timezone, in the future and at most 30 days ahead. Omit it to stop until manual Resume. POST /api/v1/agents/:key_hash/resume clears the deadline. These calls require the same management key or team owner/admin as editing the target key. Session and inference-only keys cannot stop or resume agents.</p>
    <p>GET /api/v1/agents/me and MCP anyroute_agent_rules include stopped_until when the effective stop has a deadline. Individual policies also report it. If an inherited stop has no deadline, the combined stop has no deadline. Existing responses without a timed stop keep their fields. Read-only checks reflect expiry without writing; the next enforcement check clears the stored stop and appends one hash-chain event with kind resume and reason code scheduled, in the checking transaction. Manual Resume keeps its existing resumed event.</p>
    <p>AGENT_POLICY_ENABLED defaults to false; agent routes return 404 while off. There is no timer worker or additional flag. Rules are enforced by the router only for requests through Anyroute. The router reads request text in memory on ordinary inference paths.</p>
  </section>;
}
