import { REPLAY_WORDS as W } from '../lib/rule-replay';
// Replay your rules. Linked from the docs feature index after Spending limits; this component adds no route of its own.
export default function ReplayRulesDocs() {
  return <section id="replay-rules"><h2>Replay your rules</h2>
    <p>Before you save spending limits for a saved key or agent, {W.button} runs the rules as they are in the editor against that key’s recorded calls and Agent Guard checks from the last 7 days, oldest first. It shows how many would have been allowed, sent to ask me first or refused, why, and up to 20 example calls beside what happened at the time. {W.done} After you pick a starter setup, {W.setup} does the same for that setup.</p>
    <ul>
      <li>POST /api/v1/agents/:key_hash/replay with the draft rulebook as policy and, optionally, days from 1 to 7. It needs the same permissions as saving that key’s rulebook, allows ten replays a minute per key, and reads in a read-only database transaction: nothing is saved, charged or changed.</li>
      <li>It reads up to 5,000 calls and actions, the key’s own and its session keys’: model, lane, cost, tokens and time, never the text. When there are more, truncated is true and a note says how far it reached.</li>
      <li>Running state is rebuilt the way the router keeps it: caps per hour, day and week (counting what was charged before the window), calls per hour, UTC windows, circuit breakers, progressive autonomy from its first step, and Stop. Once the rules stop the key, every later call is refused.</li>
      <li>What the record cannot tell is listed in notes rather than guessed: whether you would have approved a call sent to ask me first (it counts as not run), approvals given at the time, calls refused at the time (they have no recorded cost), and calls with no recorded estimate, output limit, tool list or lane.</li>
    </ul>
    <p>The answer has window, evaluated, allowed, denied, asked, stopped_at when the rules would have stopped the key, by_reason, actual (what happened), changed, examples (time, model, lane, cost_usd, decision, reason and actual), truncated and notes. In the client libraries it is client.agent.replay(keyHash, policy).</p>
  </section>;
}
