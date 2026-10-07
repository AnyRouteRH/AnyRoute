export default function GettingStartedDocs() {
  return <section id="getting-started">
    <h2>Getting started</h2>
    <p>Open Home to follow five steps: add funds, make your first call, set a spending limit, link Telegram and check a receipt. Each step links to where you can do it and ticks when your account shows it is done. Hide the card at any time. Finish all five and it stays hidden for this account key in this browser.</p>
    <p>Home reads the existing authenticated balance, keys, agents, activity and Telegram link APIs. Add funds counts a positive balance or a credited deposit; pending or reversed deposits do not count. A charged call counts even after you spend your balance. Any key budget, including zero, or any agent rulebook counts as a spending limit. Telegram counts only a confirmed link for the connected key.</p>
    <p>Open <code>/verify/?r=&lt;receipt id&gt;</code> with an id read from your account to tick Check a receipt. This records a visit, not a successful signature check. Up to 100 receipt ids and dismissal, completion and visit preferences are kept in browser storage, scoped to the connected key’s public hash. They are not sent to the router. Clearing browser storage resets them. Restricted keys only see the state their existing API access permits; unreadable state stays incomplete.</p>
  </section>;
}
