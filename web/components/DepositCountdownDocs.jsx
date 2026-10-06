// B123
export default function DepositCountdownDocs() {
  return <section id="deposit-countdown">
    <h2>Deposit countdown and credit notices</h2>
    <p>Follow your $ANYR or stock deposit in Payments. When the chain supplies enough timing information, the panel shows about how many minutes remain until finality. It refreshes automatically. Timing can change; when it is unknown, the panel shows the current stage. Early credit can still be reversed by a chain reorganisation.</p>
    <p><code>GET /api/v1/escrow/deposits</code> and <code>GET /api/v1/credits/deposits</code> require an active bearer key. Deposits include nullable <code>expected_final_at</code>, an approximate ISO timestamp derived from the deposit block and current chain head/finality progress. The existing account panel polls every five seconds; an expired estimate never means the transfer is final.</p>
    <p><code>DEPOSIT_PINGS_ENABLED</code> defaults to false. When enabled on the worker, include <code>deposit-pings</code> in <code>WORKER_JOBS</code>. It reads up to 100 newly credited deposits from the last day per pass, including early credits, and adds one inbox notice per deposit. The inbox uses the existing account access rules; ordinary and session keys cannot read these account notices.</p>
    <p>Existing Telegram account links can receive the token amount, credited amount and current account balance when Telegram linking and the bot are configured. The link is checked again before sending. A permanent delivery marker prevents repeat sends; interruption or failed delivery can lose a message. Linking later does not replay older deposits. The inbox remains available even if Telegram delivery fails. Credit notices are not switched on here yet.</p>
  </section>;
}
