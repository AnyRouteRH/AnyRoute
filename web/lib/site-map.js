// Shared destinations for the header, homepage, footer and on-device search.
export const GROUPS = [
  { id: 'chat', title: 'Chat' },
  { id: 'build', title: 'Build' },
  { id: 'agents', title: 'Agents' },
  { id: 'network', title: 'Network' },
  { id: 'verify', title: 'Verify' },
  { id: 'learn', title: 'Learn' },
];

const task = (id, group, title, description, href, keywords, featured = false) =>
  ({ id, group, title, description, href, keywords: keywords.split(', '), featured });

export const TASKS = [
  task('zkapi', 'build', 'Read about zkAPI payments', 'Open the Sepolia pilot and its funding, storage and privacy limits.', '/zkapi/', 'zkapi, sepolia, eth, payment'), // ZK9
  task('chat', 'chat', 'Chat with any model', 'Use Chat to send messages and choose a model.', '/harness/', 'conversation, assistant, harness', true),
  task('compare', 'chat', 'Compare model answers', 'Put models side by side in the Arena.', '/arena/', 'compare, arena, side by side', true),
  task('images', 'chat', 'Make an image', 'Choose an image-output model in Chat.', '/harness/', 'picture, draw, art, image, photo', true),
  task('vision', 'chat', 'Ask about a picture', 'Attach images in Chat with a model that reads images.', '/harness/', 'vision, upload, photograph'),
  task('voice', 'chat', 'Talk with a model', 'Use browser speech and voice controls in Chat.', '/harness/', 'voice, speech, microphone, audio'),
  task('files', 'chat', 'Ask your files', 'Add text or PDFs, ask questions and inspect the cited passages.', '/ask/', 'pdf, documents, rag, upload', true),
  task('encrypted', 'chat', 'Use encrypted chat', 'Follow the device-encryption setup for the attested gateway.', '/docs/#e2ee-phala', 'encrypted, encryption, e2ee'),
  task('history', 'chat', 'Organise your chats', 'Search, pin, rename, export or import chats in Chat.', '/harness/', 'history, conversations, export, import'),
  task('install', 'chat', 'Install the app', 'Open Chat and use browser installation on your phone or desktop.', '/harness/', 'pwa, mobile, phone, install'),
  task('models', 'chat', 'Find models and prices', 'Search one model catalog by capability, provider, context and price.', '/models/', 'catalog, pricing, cost, models, capabilities, images, audio, network'),

  task('account-activity', 'agents', 'See all your activity', 'Follow calls, approvals, alerts and funds, with receipts and exports.', '/dashboard/#activity', 'activity, history, ledger, receipts, export'),
  task('inbox', 'build', 'Check your inbox', 'Review pending approvals, alerts, deposits, agreement events and host updates.', '/dashboard/#inbox', 'inbox, notifications, attention'),
  task('dashboard', 'build', 'Manage your API keys', 'Explore your account, then connect a key to see balances, calls and rules.', '/dashboard/', 'dashboard, api key, account', true),
  task('api', 'build', 'Call the API', 'Read request formats, endpoints and the quickstart.', '/docs/#quickstart', 'api, integration, developer', true),
  task('cost', 'build', 'Estimate model costs', 'Compare input, output and monthly costs using live catalogue prices.', '/cost/', 'cost, estimate, price, monthly, budget'), // V80
  task('payments', 'build', 'Choose a way to pay', 'Read how USDG, $ANYR, stock escrow and x402 payments work.', '/docs/#payments', 'payment, usdg, anyr, stock, escrow, x402', true),
  task('tokens', 'build', 'Get private tokens', 'Buy and spend blind tokens; read the payment and transport limits.', '/tokens/', 'private tokens, blind, credits', true),
  task('seal', 'build', 'Explore SEAL', 'Read the privacy protocol, available paths and their limits.', '/seal/', 'seal, privacy, protocol'),
  task('lanes', 'build', 'Choose a routing lane', 'Compare lane disclosures and the conditions for each path.', '/docs/#lanes', 'private, attested, public, routing'),
  task('unlinkable', 'build', 'Use the unlinkable lane', 'Follow the Tor onion and blind-token requirements.', '/docs/#unlinkable-tor', 'unlinkable, tor, onion, anonymity'),
  task('proxy', 'build', 'Connect an app through the proxy', 'Read the single-file proxy setup and its privacy limits.', '/docs/#private', 'proxy, private app, command line'),
  task('spec', 'build', 'Read the protocol spec', 'Browse the published SEAL specifications and implementation status.', '/spec/', 'specification, standard, seal'),
  task('registry', 'build', 'Find a provider record', 'Inspect provider keys, build history and registry records.', '/registry/', 'registry, provider, key, build'),
  task('providers', 'build', 'Connect a provider', 'Browse providers and read the provider setup instructions.', '/providers/', 'provider, endpoint, serve, inference'),
  task('routing', 'build', 'Set up a saved route', 'Open Saved Routes in the dashboard to set models and routing preferences.', '/dashboard/', 'saved routes, fallback, policy'),
  task('json-check', 'build', 'Read JSON check options', 'Ask the router to check or repair JSON answers, and see what each costs.', '/docs/#structured-output', 'json, schema, structured output, repair'), // V83
  task('presets', 'build', 'Reuse prompt settings', 'Open Presets in the dashboard to combine prompts, models and settings.', '/dashboard/', 'preset, system prompt, template'),
  task('characters', 'build', 'Use a character card', 'Open Characters in the dashboard to import cards and choose their visibility.', '/dashboard/', 'character, persona, card'),
  task('batches', 'build', 'Run a batch of requests', 'Open Batch Studio in the dashboard to submit and follow request batches.', '/dashboard/', 'batch, bulk, csv, jsonl'),
  task('teams', 'build', 'Manage a team', 'Open Teams in the dashboard to manage roles, budgets, keys and invitations.', '/dashboard/', 'team, invite, roles'),
  task('tracing', 'build', 'Trace a request', 'Open Tracing in dashboard API keys to inspect request traces.', '/dashboard/', 'trace, debugging, latency'),
  task('playground', 'build', 'Send an API request', 'Open Playground in the dashboard to send a request and inspect its receipt.', '/dashboard/', 'playground, api request'),
  task('evals', 'build', 'Evaluate model answers', 'Open Eval Lab in the dashboard to compare answers against your cases.', '/dashboard/', 'eval, evaluation, rubric, benchmark'),
  task('skills', 'build', 'Inspect a skill', 'Open Skills in the dashboard to read scan reports and installation details.', '/dashboard/', 'skills, scan, install'),
  task('spend', 'build', 'Watch API spending', 'Open Spend Watch in the dashboard to inspect usage and spending controls.', '/dashboard/', 'spend watch, usage, costs'),
  task('api-receipts', 'build', 'Review your API calls', 'Open Activity for calls, receipts and account events; Receipts keeps extra tools.', '/dashboard/#activity', 'api receipts, calls, history'),
  task('holders', 'build', 'Inspect $ANYR account benefits', 'Open Holders in the dashboard to inspect balance, tier and credit details.', '/dashboard/', 'holders, tier, balance, anyr'),
  task('settings', 'build', 'Set account preferences', 'Open Settings in the dashboard to manage account preferences.', '/dashboard/', 'settings, account, preferences'),
  task('mcp', 'build', 'Connect agent tools', 'Read the MCP tool interface and connection instructions.', '/docs/#mcp', 'mcp, tools, agent'),

  task('agent-guard', 'agents', 'Read about action rules', 'Read the action checks and execution limits; switched on at anyroute.tech.', '/docs/#agent-guard', 'agent guard, order, trade, swap, action'), // V98
  task('rulebook', 'agents', 'Give an agent a budget', 'Set caps, models, lanes, tools and hours for requests through Anyroute.', '/agents/', 'agent, rulebook, budget, limits', true),
  task('sessions', 'agents', 'Give an agent a session', 'Open Agent Sessions in the dashboard to set a session budget and lifetime.', '/dashboard/', 'agent sessions, session, ttl'),
  task('approvals', 'agents', "Approve an agent’s payment", 'Review how approvals work, then connect a key to approve or deny a request.', '/agents/', 'approval, approve, deny, payment', true),
  task('telegram', 'agents', 'Link Telegram approvals', 'Connect Telegram from Agents for approvals and alerts.', '/agents/', 'telegram, bot, notification'),
  task('activity', 'agents', 'Review agent activity', 'Open Activity for calls and agent events; Agents keeps the per-agent ledger.', '/dashboard/#activity', 'activity, ledger, receipts, csv, json'),
  task('alerts', 'agents', 'Set agent alerts', 'Configure the alert feed, spend webhook or linked Telegram notifications.', '/agents/', 'alerts, notification, webhook'),
  task('breakers', 'agents', 'Set circuit breakers', 'Configure rulebook breakers that stop subsequent requests through Anyroute.', '/agents/', 'breaker, kill switch, stop, safety'),
  task('autonomy', 'agents', 'Adjust agent autonomy', 'Review progressive autonomy and spending caps for a selected agent.', '/agents/', 'autonomy, spending, caps'),
  task('certificates', 'agents', 'Check an agent’s track record', 'Read the router-signed certificate format, lifetime and verification limits.', '/docs/#agent-certificates', 'certificate, track record, reputation'),
  task('directory', 'agents', 'Find an agent', 'Browse opt-in public profiles and owner-supplied capabilities.', '/agents/directory/', 'directory, discover, agent card', true),
  task('profile', 'agents', 'Publish an agent profile', 'Manage an opt-in public profile and its rulebook summary.', '/agents/directory/', 'profile, publish, agent card'),
  task('agreements', 'agents', 'Make an agreement between agents', 'Select an agent, then Agreements to use USDG milestone escrow.', '/agents/', 'agreement, milestone, escrow, jury'),
  task('sealed', 'agents', 'Host a sealed agent', 'Read the hosting recipe; no sealed agent is registered on this site yet.', '/docs/#sealed-agents', 'sealed agent, hosting, sidecar, tdx'),

  task('network', 'network', 'See live network stats', 'Inspect host counts, available models and policy version.', '/network/', 'stats, network, capacity', true),
  task('join', 'network', 'Host hardware on the network', 'Join with the approved early-host build in a supported confidential VM.', '/network/#join', 'host, gpu, server, hardware, join', true),
  task('readiness', 'network', 'Check your hardware', 'Read and download the capability checker before joining.', '/network/#readiness', 'hardware, checker, tdx, sev, gpu'),
  task('hosts', 'network', 'Inspect host records', 'Inspect hardware checks, recorded builds and work roots for each host.', '/hosts/', 'hosts, records, attestation', true),
  task('policy', 'network', 'Read the host policy', 'Read the signed admission policy and host requirements.', '/docs/#network-host-policy', 'policy, admission, sanctions'),
  task('interest', 'network', 'Register network interest', 'Tell the network what hardware or capacity you would bring.', '/network/#waitlist', 'waitlist, interest, capacity'),

  task('receipt', 'verify', 'Check a receipt', 'Inspect signatures, recorded hashes and the checks a receipt can support.', '/verify/#v-receipt', 'receipt, proof, signature, verify', true),
  task('status', 'verify', 'Check service status', 'Inspect API health, lane availability and recent incidents.', '/status/', 'status, uptime, health, outage', true),
  task('keep', 'verify', 'See what we keep', 'Inspect storage, logs and the places request text or addresses are read.', '/keep/', 'data, privacy, retention, inventory', true),
  task('key-log', 'verify', 'Inspect the key log', 'Read the signing-key transparency log and anchoring instructions.', '/docs/#key-log', 'key log, transparency, rekor'),
  task('inventory-log', 'verify', 'Check the inventory log', 'Inspect the provenance and transparency proof for the data inventory.', '/keep/#provenance', 'transparency log, inventory, hash'),
  task('provider-check', 'verify', 'Check provider evidence', 'Inspect provider attestation and the limits of each check.', '/verify/', 'provider, attestation, hardware, evidence'),
  task('badge', 'verify', 'Embed a provider badge', 'Read how to show a provider’s verification status and receipt evidence.', '/docs/#badge', 'badge, embed, status'),
  task('proof-time', 'verify', 'Inspect proof freshness', 'Read proof-time observations and what they establish.', '/status/#proof-time', 'proof time, freshness, evidence'),

  task('docs', 'learn', 'Read the docs', 'Browse guides and reference sections for Anyroute tools.', '/docs/', 'documentation, guide, help', true),
  task('changelog', 'learn', "See what's new", 'Follow shipped changes with links to their pages and public commits.', '/changelog/', 'changelog, updates, shipped, rss, atom'), // V89: page, menu, footer and search.
  task('whitepaper', 'learn', 'Read the whitepaper', 'Read the architecture, payment design and routing model.', '/whitepaper/', 'whitepaper, paper, architecture', true),
  task('case-study', 'learn', 'Read the case study', 'Follow an application integration and its routing choices.', '/case-study/', 'case study, example, integration'),
  task('roadmap', 'learn', 'See the roadmap', 'See what is available and what comes next.', '/#roadmap', 'roadmap, planned, future'),
  task('about', 'learn', 'Learn about Anyroute', 'Read the project’s purpose and approach.', '/#about', 'about, purpose, project'),
  task('privacy-notice', 'learn', 'Read the data notice', 'Read the site’s data-handling notice and privacy limits.', '/legal/privacy/', 'legal, privacy notice, data notice'),
  task('terms', 'learn', 'Read the terms', 'Read the terms for using Anyroute.', '/legal/terms/', 'legal, terms, conditions'),
];
TASKS.push(task('agent-spend-glance', 'agents', 'See agent spending', 'Compare seven days of charged spending and each agent’s latest call.', '/agents/', 'agents, spend, daily, week, model, calls')); // C132


// Tools that live inside a page tab are found through search; menus, the mobile menu and the footer stay short.
const SEARCH_ONLY = new Set([
  'agent-guard', // V98
  'json-check', /* V83 */ 'inbox', 'activity', 'history', 'unlinkable', 'proxy', 'registry', 'routing', 'presets', 'characters', 'batches', 'teams', 'tracing', 'playground', 'evals', 'skills', 'spend', 'api-receipts', 'holders', 'settings', 'sessions', 'breakers', 'autonomy', 'profile', 'inventory-log', 'badge', 'proof-time']);
SEARCH_ONLY.add('agent-spend-glance'); // C132
SEARCH_ONLY.add('payments'); SEARCH_ONLY.add('get-usdg'); // ON1: funding joins Build; payment reference stays searchable.
TASKS.push(task('get-usdg', 'build', 'Get USDG', 'How to get USDG on Robinhood Chain. USDG deposits are not switched on here yet.', '/docs/#get-usdg', 'usdg, bridge, buy, chain')); // ON1
SEARCH_ONLY.add('spec'); // V80: keep Build at nine menu tools; spec stays searchable.
SEARCH_ONLY.add('zkapi'); // ZK9: search-only Sepolia pilot.
TASKS.push(task('facilitator', 'build', 'Settle x402 payments for your API', 'Verify and settle USDG payments on Robinhood Chain; the router only pays gas.', '/facilitator/', 'x402, facilitator, seller, settle, bazaar, discovery, usdg')); // v6 F
SEARCH_ONLY.add('facilitator'); // v6 F: off until switched on, so search-only.
SEARCH_ONLY.add('make-good'); TASKS.push(task('make-good', 'build', 'Read make-good refund rules', 'See when a failed, cut-off or rerouted call is refunded, with a signed refund receipt.', '/docs/#make-good-refunds', 'refund, make good, failover, truncated, receipt')); // V6 R
for (const item of TASKS) item.menu = !SEARCH_ONLY.has(item.id);
TASKS.push({ ...task('weekly-summary', 'agents', 'Weekly Telegram summary', 'Read about weekly agent spend, approvals and Stops in Telegram; not switched on yet.', '/docs/#weekly-summary', 'telegram, weekly, summary'), menu: false }); // B120
TASKS.push({ ...task('getting-started', 'build', 'Follow your getting started checklist', 'Open Home to add funds, make a call, set a limit, link Telegram and check a receipt.', '/dashboard/#home', 'getting started, checklist, first call, funds, limit, telegram, receipt'), menu: false }); // C135
TASKS.push({ ...task('price-notices', 'build', 'Read model price change notices', 'See how notices report changed model rates; not switched on yet.', '/docs/#price-notices', 'model, price, cheaper, pricier, inbox, telegram'), menu: false }); // C133
TASKS.push({ ...task('model-alternatives', 'chat', 'Try a similar model', 'Choose an available model when a reply cannot be served.', '/docs/#errors', 'unavailable, error, retry, similar, capabilities'), menu: false }); // B121: search only.
TASKS.push({ ...task('balance-runway', 'build', 'Check balance runway', 'See how long your balance lasts at your seven-day spending pace.', '/docs/#balance-runway', 'balance, runway, low balance, alert, money'), menu: false }); // B119: searchable.
TASKS.push({ ...task('telegram-balance-spend', 'agents', 'Check balance and spend in Telegram', 'Use your linked account to read balance, spending pace and top agents in Telegram.', '/docs/#telegram-balance-spend', 'telegram, balance, spend, runway, bot, top agents'), menu: false }); // E152
TASKS.push({ ...task('paid-tools', 'build', 'Browse paid tools', 'List x402 tools a key can pay from its balance, with their canary state.', '/tools/', 'tools, x402, paid, mcp, canary'), menu: false }); // v6 T: search-only until switched on.
TASKS.push({ ...task('stop-until', 'agents', 'Stop for a while', 'Stop an agent for one hour, until tomorrow morning, or until you resume.', '/docs/#stop-until', 'stop, pause, resume, tomorrow'), menu: false }); // B117: search-only.
TASKS.push({ ...task('chat-limits', 'chat', 'Limit chat spending', 'Open Tools in Chat to cap spending, approve replies and stop chat.', '/harness/', 'limits, budget, spending, approval, stop'), menu: false }); // U77: search-only control.
TASKS.push({ ...task('starter-setups', 'agents', 'Start from a setup', 'Fill spending limits from a ready-made setup, review it, then save.', '/agents/#starter-setups', 'starter, setup, template, budget, rules, chatbot, trading, batch, proven hardware'), menu: false }); // U103: replaces V85's rulebook templates; /agents/#rulebook-templates lands on the same place.
TASKS.push({ ...task('replay-rules', 'agents', 'Replay a rulebook on last week', 'See what draft rules would have allowed, asked or refused over the last 7 days.', '/agents/#replay-rules', 'replay, rules, rulebook, draft, last week, spending limits, try'), menu: false }); // Replay your rules: search-only.
TASKS.push({ ...task('pay-agent', 'agents', 'Pay another agent', 'Your rulebook decides, your wallet sends USDG, Anyroute checks it and signs a receipt.', '/agents/#pay-agent', 'pay, payment, send, agent, usdg, wallet, receipt'), menu: false }); // Pay another agent: search-only until switched on.
TASKS.push({ ...task('request-check', 'agents', 'Check a request against your rules', 'Check agent rules without spending: allow, approval required or deny.', '/agents/#request-check', 'check, try, request, rules'), menu: false }); // V85: search-only.
TASKS.push({ ...task('prompt-library', 'chat', 'Save and reuse prompts', 'Keep named prompts in this browser and fill in variables before using them.', '/harness/#prompt-library', 'prompts, library, templates, favourites'), menu: false }); // V81: search-only, keeps menus short.
TASKS.push({ ...task('why-this-route', 'learn', 'Understand a route', 'See why each reply went to its provider, and what that explanation does not show.', '/docs/#why-this-route', 'route explanation, provider, routing, fallback'), menu: false }); // V84: search only.
TASKS.push({ ...task('decision-tags', 'verify', 'Tie an order to the model call behind it', 'Sign an order’s hash into a call’s receipt and check it later.', '/docs/#decision-tags', 'decision tag, decision receipt, order, trade, hash, agent guard, informed by'), menu: false }); // B: search-only until switched on.
TASKS.push({ ...task('lane-report', 'verify', 'See where your calls ran', 'Calls and spend by lane, the share on proven hardware and each provider’s evidence.', '/dashboard/#statements', 'lane, lanes, lane report, attested, unlinkable, public, proven hardware, where, evidence'), menu: false }); // Lane report: search-only, on Statements.
TASKS.push({ ...task('insights', 'build', 'See where your money goes', 'See spend by model, key and lane, and the same abilities for less.', '/dashboard/#insights', 'spend, insights, cost, model, key, agent, lane'), menu: false }); // V88: search-only.
TASKS.push({ ...task('idempotency', 'build', 'Retry without paying twice', 'Keep the same retry key to recover a reply and its receipt without another charge.', '/docs/#idempotency', 'retry, idempotency, receipt, charge'), menu: false }); // D145
export const menuTasks = group => TASKS.filter(item => item.group === group && item.menu);
TASKS.push({ ...task('chat-cost', 'chat', 'See this chat’s cost', 'See the running cost and reply count across Chat lanes and saved chats.', '/docs/#chat-cost', 'chat, cost, total, replies, compare, spending, history'), menu: false }); // C128

TASKS.push({ ...task('webhooks', 'build', 'Manage webhook destinations', 'Inspect signing availability, event subscriptions and delivery history.', '/dashboard/webhooks/', 'webhooks, events, signature'), menu: false }); // V86: search-only account tool.
TASKS.push({ ...task('playbooks', 'agents', 'Share one rulebook across agents', 'Keep one playbook of rules that many agents and keys follow, and change it once.', '/dashboard/#playbooks', 'playbook, shared rules, rulebook, team, agents, keys, limits'), menu: false }); // U115: search-only; the Agents menu is full.
TASKS.push({ ...task('commerce', 'verify', 'Read the commerce ledger', 'See anchored settlements without self-dealing, beside the gross figures.', '/commerce/', 'commerce, settlements, volume, self-dealing, dune'), menu: false }); // v6 L: search-only.

TASKS.push({ ...task('notifications', 'build', 'Choose notifications', 'Choose inbox and Telegram notices and quiet hours.', '/dashboard/#notifications', 'notifications, settings, telegram, inbox, quiet hours'), menu: false }); // E146
// Account sections share the task map; existing dashboard hashes remain stable.
// U104: five account tabs. Each opens its first section; its id is also a dashboard hash (#keys opens API keys).
TASKS.push({ ...task('schedules', 'build', 'Schedule a prompt', 'Run saved prompts on a schedule using your key’s limits and rulebook.', '/dashboard/#schedules', 'schedule, prompt, recurring, hourly, daily, monday'), menu: false }); // D136
export const ACCOUNT_GROUPS = [
  { id: 'overview', title: 'Overview', ids: ['dashboard', 'inbox', 'account-activity', 'insights'] },
  { id: 'build', title: 'Build', ids: ['playground', 'models', 'routing', 'presets', 'characters', 'evals', 'batches', 'skills', 'providers'] },
  { id: 'keys', title: 'Keys & limits', ids: ['account-keys', 'rulebook', 'playbooks', 'sessions', 'spend', 'teams', 'directory'] },
  { id: 'billing', title: 'Billing', ids: ['account-payments', 'api-receipts', 'statements', 'holders'] },
  { id: 'schedules', title: 'Schedules', ids: ['schedules'] }, // D136
  { id: 'settings', title: 'Settings', ids: ['settings', 'account-export', 'webhooks', 'keep'] },
];
ACCOUNT_GROUPS.find(group => group.id === 'settings').ids.push('notifications'); // E146
TASKS.push(task('account-keys', 'build', 'Manage account keys', 'Explore API keys, then connect to create keys and set budgets.', '/dashboard/#api-keys', 'api keys, budget'));
TASKS.push(task('account-payments', 'build', 'Add funds', 'Connect your key and choose a token to see live deposit instructions.', '/dashboard/#payments', 'balance, deposit'));
TASKS.find(item => item.id === 'account-payments').menu = true; // ON1: Build menu and existing Money section.
for (const id of ['account-keys']) TASKS.find(item => item.id === id).menu = false;
const accountSection = (taskId, title, hash, description, start) => ({ taskId, title, hash, description, start, href: hash ? '/dashboard/#' + hash : TASKS.find(item => item.id === taskId).href });
export const ACCOUNT_SECTIONS = [
  accountSection('schedules', 'Schedules', 'schedules', 'Save prompts to run on a schedule with your key’s limits and rulebook.', 'Connect an owner key to save schedules and read results.'), // D136
  accountSection('insights', 'Insights', 'insights', 'Explore spending by day or week, model, key or agent and lane, with live price comparisons.', 'Connect your key to see where your money goes.'), // V88: signed-out preview.
  accountSection('webhooks', 'Webhooks', null, 'Inspect event destinations, signing availability and delivery history.', 'Connect an owner key to manage webhook destinations and see deliveries.'), // V86.
  accountSection('inbox', 'Inbox', 'inbox', 'Review pending approvals and new alerts, deposits, agreement events and host updates.', 'Connect your key to check items that need your attention.'),
  accountSection('dashboard', 'Home', 'home', 'See your balance, spending, keys, agents and recent call receipts in one place.', 'Connect your key to see what you own and what needs your attention.'),
  accountSection('account-activity', 'Activity', 'activity', 'Follow calls, approvals, alerts, deposits and agreements in one list.', 'Connect your key to read visible activity and export a filtered range.'),
  accountSection('playground', 'Playground', 'playground', 'Send an API request and inspect its answer, cost and receipt.', 'Connect your key, choose a model and send a request.'),
  accountSection('models', 'Models', 'models', 'Browse models, providers and per-token prices.', 'Connect your key to choose a model for your next call.'),
  accountSection('routing', 'Saved Routes', 'saved-routes', 'Save model choices, fallbacks and routing preferences for repeat calls.', 'Connect your key to create a saved route.'),
  accountSection('presets', 'Presets', 'presets', 'Reuse prompts, models and request settings.', 'Connect your key to save a preset.'),
  accountSection('characters', 'Characters', 'characters', 'Import character cards and choose who can use them.', 'Connect your key to import a card.'),
  accountSection('evals', 'Eval Lab', 'eval-lab', 'Compare model answers against your own cases.', 'Connect your key to add cases and run a comparison.'),
  accountSection('batches', 'Batch Studio', 'batch-studio', 'Submit groups of requests and follow their progress.', 'Connect your key to submit a batch.'),
  accountSection('skills', 'Skills', 'skills', 'Read skill scan reports and installation details.', 'Connect your key to inspect a skill.'),
  accountSection('rulebook', 'Agents', null, 'Set budgets and rules, stop agents and review requests waiting for approval.', 'Connect a management key or an owner/admin key to manage agents.'),
  accountSection('playbooks', 'Playbooks', 'playbooks', 'Keep one set of rules that many agents and keys follow, and change it once.', 'Connect a management key or a team owner/admin key to manage playbooks.'), // U115
  accountSection('sessions', 'Agent Sessions', 'agent-sessions', 'Give an agent a spending budget and a time limit.', 'Connect your key to open a session.'),
  accountSection('directory', 'Public directory', null, 'Browse opt-in agent profiles and owner-supplied capabilities.', 'Open the public directory to find an agent; no key is needed.'),
  accountSection('account-payments', 'Payments', 'payments', 'See your balance, deposit instructions and payment options.', 'Connect your key to add funds.'),
  accountSection('holders', 'Holders', 'holders', 'Inspect your $ANYR balance, tier and credit details.', 'Connect your key to read your account details.'),
  accountSection('spend', 'Spend Watch', 'spend-watch', 'Inspect spending and configure spending alerts.', 'Connect your key to read usage and set a spending threshold.'),
  accountSection('api-receipts', 'Receipts', 'receipts', 'Inspect recorded calls, costs and signed receipts.', 'Connect your key to read your call history.'),
  accountSection('account-keys', 'API keys', 'api-keys', 'Create keys, set budgets and manage access to your account.', 'Connect your key to manage account keys.'),
  accountSection('teams', 'Teams', 'teams', 'Manage team roles, budgets, keys and invitations.', 'Connect your key to manage a team, or follow your invitation link.'),
  accountSection('providers', 'Providers', 'providers', 'Inspect provider records, hardware evidence and model availability.', 'Connect your key to inspect providers, or browse the public provider page.'),
  accountSection('settings', 'Settings', 'settings', 'Export account metadata and read how to connect an app.', 'Connect your key to read your account settings.'),
  accountSection('keep', 'What we keep', null, 'Inspect storage, logs and where request text or addresses are read.', 'Open What we keep to read the inventory; no key is needed.'),
];

// V87: account-only destinations, also available through search.
TASKS.push({ ...task('statements', 'build', 'Download a monthly statement', 'Download a signed monthly statement as JSON, or print it to PDF.', '/dashboard/#statements', 'statement, monthly, balance, money, pdf'), menu: false }, { ...task('account-export', 'build', 'Export your data', 'Download accessible account records with an inclusion manifest.', '/dashboard/#export-data', 'export, download, account, data'), menu: false });
ACCOUNT_SECTIONS.push(accountSection('statements', 'Statements', 'statements', 'Download a signed monthly statement as JSON, or print it to PDF.', 'Connect a key to request a statement.'), accountSection('account-export', 'Export your data', 'export-data', 'Take readable account records with you in one JSON download.', 'Connect a key to export records within its access.'));

ACCOUNT_SECTIONS.push(accountSection('notifications', 'Notifications', 'notifications', 'Choose your inbox and Telegram notices and quiet hours.', 'Connect an account management key to choose notifications.')); // E146
for (const section of ACCOUNT_SECTIONS) {
  const item = TASKS.find(task => task.id === section.taskId);
  if (section.hash && item.href === '/dashboard/') item.href = section.href;
}

TASKS.push({ ...task('operations', 'build', 'Inspect service operations', 'Use the service operator token to inspect monitoring availability and daily counts.', '/admin/', 'operator, upstream, balance, counts'), menu: false }); // ON3: search-only.
TASKS.push({ ...task('auto-topup', 'agents', 'Refill a key’s budget from your credits', 'Top up a key automatically from your credits when it runs low, within a weekly limit.', '/dashboard/#api-keys', 'auto top-up, top up a key automatically, refill, budget, credits, agent, key, weekly'), menu: false }); // U107: search-only.
TASKS.push({ ...task('key-management', 'build', 'Read key provisioning options', 'Read capped-key fields, pagination and inference-only keys.', '/docs/#key-management', 'key, provisioning, scope, inference, management'), menu: false }); // ZK6: search only.
TASKS.push({ ...task('unused-keys', 'build', 'Review unused keys', 'Review keys unused for 30 days and switch off those you no longer need.', '/dashboard/#api-keys', 'unused keys, last used, cleanup, switch off, 30 days, management keys'), menu: false }); // B125
TASKS.push({ ...task('key-expiry', 'build', 'Set a key’s expiry', 'Choose when an account key stops working and see its days left.', '/docs/#key-expiry', 'keys, expiry, expires, expiration, date, deadline'), menu: false }); // C127
TASKS.push({ ...task('labs', 'learn', 'See Labs: built but switched off', 'Features built but switched off or in a pilot, each state read live from status.', '/labs/', 'labs, experimental, switched off, pilot, flags, x402, zkapi, host bonds'), menu: true }); // U104: last in Learn.

// U106: things ⌘K can do. Each names the task whose page does it, so search, menus and actions share this one map.
// signIn: needs a connected key. pick: the step that chooses what to act on (agent, model or receipt id).
// run: Stop or Resume, called only after the same confirm step /agents asks. focus: the part of the limits editor to open.
const action = (id, taskId, title, description, keywords, more = {}) => ({ id, task: taskId, title, description, keywords: keywords.split(', '), featured: true, ...more });
export const ACTIONS = [
  action('add-funds', 'account-payments', 'Add funds', 'Open Payments to see your balance and how to deposit.', 'add money, top up, deposit, fund, balance, pay, usdg, credit', { signIn: true }),
  action('new-key', 'account-keys', 'New API key', 'Open API keys with the Create key form ready to fill in.', 'new key, create key, make key, api key, generate', { signIn: true, open: 'new-key' }),
  action('set-limit', 'rulebook', 'Set a spending limit', 'Choose a key or agent, then edit the caps in its spending limits.', 'limit, budget, cap, spending, maximum, change', { signIn: true, pick: 'agent', focus: 'limits' }),
  action('stop-agent', 'rulebook', 'Stop an agent', 'Choose an agent and confirm; its new requests are refused until you resume it.', 'stop, pause, halt, freeze, kill, block, agent', { signIn: true, pick: 'agent', run: 'stop' }),
  action('resume-agent', 'rulebook', 'Resume an agent', 'Choose a stopped agent and confirm to let its requests through again.', 'resume, restart, unpause, start, continue, unblock, agent', { signIn: true, pick: 'agent', run: 'resume' }),
  action('open-receipt', 'receipt', 'Open a receipt by id', 'Enter a receipt id to read its plain-English label on Verify.', 'receipt, id, lookup, look up, find, verify', { pick: 'receipt' }),
  action('chat-model', 'chat', 'Switch Chat model', 'Choose a model, then open Chat with it selected.', 'model, switch, change, choose, pick, chat, llm', { pick: 'model' }),
  action('default-route', 'rulebook', 'Set default route', 'Choose a key or agent, then set the route for requests that name no lane.', 'route, routing, default, lane, change', { signIn: true, pick: 'agent', focus: 'route' }),
];

TASKS.push({ ...task('approve-and-allow', 'agents', 'Allow this next time', 'Review and raise an agent’s ask-first amount while approving one request.', '/docs/#approve-and-allow', 'approve, approval, ask first, amount, threshold, allow next time'), menu: false }); // B118
TASKS.push({ ...task('proof-pack-check', 'verify', 'Check a proof pack', 'Check receipts, statements and lane totals in your browser. Your file is never uploaded.', '/verify/#v-proof-pack', 'proof pack, file, receipts, statements, signatures, lane report'), menu: false }); // B122
TASKS.push(task('deposit-countdown', 'build', 'Follow a deposit', 'Read about finality estimates and optional credit notices.', '/docs/#deposit-countdown', 'deposit, countdown, finality, credited, telegram')); // B123
TASKS.push({ ...task('rulebook-words', 'agents', 'Read your rulebook in plain English', 'See spending caps, allowed models and working hours as short sentences.', '/docs/#rulebook-words', 'rules, rulebook, limits, plain english'), menu: false }); // B124: search only
TASKS.push({ ...task('copy-as-code', 'chat', 'Copy a Chat conversation as code', 'Take the selected conversation and its settings into curl, TypeScript or Python.', '/harness/', 'copy as code, request, curl, typescript, python, conversation'), menu: false }); // C130
TASKS.push({ ...task('share-to-anyroute', 'chat', 'Share to Anyroute from your phone', 'Bring text, links or images into a Chat draft from your phone’s share sheet.', '/docs/#share-to-anyroute', 'share, share sheet, phone, mobile, images, links, draft'), menu: false }); // D137

TASKS.push({ ...task("context-meter", "chat", "Keep room in Chat", "See context use and summarize a conversation to continue with more room.", "/docs/#context-meter", "context, tokens, window, summarize, summary, chat"), menu: false }); // C129

TASKS.push({ ...task('appearance', 'learn', 'Choose light or dark', 'Choose Light, Dark or Match device in the account menu or footer.', '/docs/#appearance', 'theme, dark, light, appearance, device'), menu: false }); // C126

TASKS.push({ ...task('new-models', 'chat', 'Find new models this week', 'Browse recently added models and subscribe to the new models feed.', '/docs/#new-models', 'new models, catalogue, atom, feed, this week'), menu: false }); // C131

TASKS.push({ ...task('projects', 'build', 'Group calls by project', 'Tag calls and filter Activity and Insights by project.', '/docs/#projects', 'project, tags, spending, activity, insights'), menu: false }); // C134

TASKS.push({ ...task("saved-answers", "chat", "Find saved answers", "Save replies in encrypted browser history and search them later.", "/docs/#saved-answers", "saved answers, save, replies, chat, search, history, export"), menu: false }); // D140
TASKS.push({ ...task('chat-folders', 'chat', 'Organize Chat into folders', 'Create folders, move chats and search a folder or all saved chats.', '/docs/#chat-folders', 'chat, folders, history, organize, move, search'), menu: false }); // D143
TASKS.push({ ...task("telegram-photos", "build", "Send photos in Telegram", "Read about photo questions and privacy in Telegram; not switched on yet.", "/docs/#telegram-photos", "telegram, bot, photos, images, vision"), menu: false }); // D142
TASKS.push({ ...task('quiet-agent-alerts', 'agents', 'Hear when an agent goes quiet', 'Choose an inactivity window for inbox and Telegram alerts; not switched on yet.', '/docs/#quiet-agent-alerts', 'agent, quiet, inactive, calls, alert, telegram'), menu: false }); // D141
TASKS.push({ ...task("security-alerts", "build", "Keep track of security changes", "Read about account security alerts and their Settings switch.", "/docs/#security-alerts", "security, alerts, sign-in, keys, telegram, roles"), menu: false }); // D138
TASKS.push({ ...task('project-budgets', 'build', 'Set a project spending limit', 'Share a monthly budget across calls tagged with a project.', '/docs/#project-budgets', 'project, budget, monthly, spending, limit, inbox'), menu: false }); // D139
TASKS.push({ ...task('rulebook-history', 'agents', 'Review rulebook history', 'See saved rules and restore a previous version after confirming.', '/docs/#rulebook-history', 'rulebook, history, restore, versions, changes'), menu: false }); // D144

TASKS.push({ ...task("signed-in-browsers", "build", "Review signed-in browsers", "Open Settings to sign out a wallet sign-in or all other browsers.", "/dashboard/#settings", "browsers, sessions, sign out, wallet sign-in, security"), menu: false }); // E147
TASKS.push({ ...task("model-performance", "build", "Sort models by speed and reliability", "Compare recent latency, tokens per second and observed reliability in the catalogue.", "/docs/#model-performance", "models, catalogue, fastest, throughput, reliable, uptime, latency"), menu: false }); // E150
TASKS.push({ ...task("model-pages", "chat", "Open a model page", "See a model’s abilities, prices, providers and health, then try it in Chat.", "/models/model/", "model, details, catalogue, health, speed, providers"), menu: false }); // E151
TASKS.push({ ...task('reliability-report', 'build', 'See your reliability report', 'See your recorded calls, fallback use, timing and refusal counts by model.', '/dashboard/#insights', 'reliability, success, fallback, latency, refusals, model, calls'), menu: false }); // E155
