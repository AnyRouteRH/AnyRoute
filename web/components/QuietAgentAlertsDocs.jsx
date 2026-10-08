export default function QuietAgentAlertsDocs() {
  return <section id="quiet-agent-alerts">
    <h2>Quiet-agent alerts</h2>
    <p>Choose how long an agent can go without a call before you hear about it. Each agent row has an Off, 1, 3, 6, 12, 24 or 72 hour choice. You receive one inbox notice per quiet period, plus a Telegram message if you have linked Telegram. Stopped agents are excluded.</p>
    <p>A charged model or tool call, or a recorded Agent Guard decision, starts the clock again. This includes calls from the agent’s session keys. Free calls without a charge and rulebook previews do not count. If no activity is recorded, the clock starts when you enable the alert. Checks run every five minutes, so a notice may arrive after the chosen window. Calls sent elsewhere are outside this view.</p>
    <p><code>GET /api/v1/agents/:key_hash/quiet-alert</code> returns <code>{'{ data: { key_hash, hours } }'}</code>. <code>PUT</code> to the same path accepts <code>{'{ hours: null }'}</code> for Off or one of the supported hour values. Settings are separate from the rulebook. Management keys and team owners or admins may manage their own agents; inference and session keys are refused.</p>
    <p><code>QUIET_AGENT_ALERTS_ENABLED</code> defaults to <code>false</code> and requires agent rulebooks to be enabled. While off, these endpoints return 404 and no quiet-alert job is registered. This feature is not switched on yet. Resuming a stopped agent makes its existing call clock eligible again; changing the window uses that same clock. Changing or saving a choice does not repeat an already-sent notice before the next call.</p>
    <p>Notices keep the agent’s name, window and last recorded activity time, with up to 100 notices per agent for 90 days. Telegram gets readable notice text. Telegram delivery is attempted once after the inbox notice is saved; a failed send or an interrupted worker can leave an inbox notice without a Telegram message.</p>
  </section>;
}
