import { STARTER_RULEBOOKS } from '../lib/agent-starters';
import { GUARD_STARTERS } from '../lib/agent-guard';
import { LIMIT_WORDS as W } from '../lib/spending-limits';
import { MARKET_HOURS_NOTE, STARTER_SETUPS, openLine, setupSummary } from '../lib/starter-setups';
// U103: starter setups. Linked from the docs page next to Spending limits and Default route; no route of its own. The list
// is built from the same data the editor uses, so it always shows the values a setup fills.
const sourceName = id => [...STARTER_RULEBOOKS, ...GUARD_STARTERS].find(s => s.id === id).name;
const values = setup => {
  const { lines, open } = setupSummary(setup, { view: 'agents', guard: true });
  return [...lines.map(l => l.text), openLine(open)].filter(Boolean);
};

export default function StarterSetupsDocs() {
  return <section id="starter-setups"><h2>Starter setups</h2>
    <p>A starter setup fills the spending limits editor with a set of values in one click. Choose Start from a setup at the top of Spending limits: for an agent on the Agents page, for a key under API keys in the dashboard, or in chat limits. Picking one lists what it sets and fills the fields; nothing is saved until you save, which writes that key’s rulebook with PUT /api/v1/agents/:key_hash/policy as before. Undo puts back the earlier values. Setups add no endpoint and no rulebook field: each is built from the starter rulebooks, Agent Guard’s action rulebooks and the <a href="#default-route">default route</a>, with their numbers unchanged. {W.scopeOnly}</p>
    <ul>{STARTER_SETUPS.map(s => <li key={s.id}><strong>{s.name}</strong>, from {s.from.map(sourceName).join(' and ')}. {s.blurb}<ul>{values(s).map(text => <li key={text}>{text}</li>)}</ul></li>)}</ul>
    <p>Each editor fills only what it shows. Chat limits fill the caps and the ask-first amount, and offer {STARTER_SETUPS.filter(s => s.chat).map(s => s.name).join(' and ')}. API keys also fill models, lanes, the default route, tools and, where Agent Guard is switched on, actions. Agents also fills reply length, calls per hour, what happens over a limit, UTC hours and circuit breakers. Anything a setup does not list stays as it is, including the chat key’s total and expiry, autonomy, agreements and paid tool prices; alerts and actions change only when a setup carries them.</p>
    <p>Trading agent’s order rules and market hours apply only where Agent Guard is switched on. {MARKET_HOURS_NOTE} On the Agents page, More starting points still lists each earlier starter rulebook and, where Agent Guard is switched on, each action rulebook; they now fill the editor the same way instead of saving at once.</p>
    <p>With Proven hardware only, a request that names no lane goes only to endpoints with a fresh hardware attestation the router verified, and is refused with nothing charged when none can serve it. Proven hardware first falls back to a standard provider and labels the request as such. <a href="/status/#proof-time">Proof-time</a> shows how recently each attesting provider’s hardware was verified. On every lane the router still reads ordinary request text in memory.</p>
  </section>;
}
