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
  task('chat', 'chat', 'Chat with any model', 'Use the Harness to send messages and choose a model.', '/harness/', 'conversation, assistant, harness', true),
  task('compare', 'chat', 'Compare model answers', 'Put models side by side in the Arena.', '/arena/', 'compare, arena, side by side', true),
  task('images', 'chat', 'Make an image', 'Choose an image-output model in the Harness.', '/harness/', 'picture, draw, art, image, photo', true),
  task('vision', 'chat', 'Ask about a picture', 'Attach images to a Harness chat with a model that reads images.', '/harness/', 'vision, upload, photograph'),
  task('voice', 'chat', 'Talk with a model', 'Use browser speech and voice controls in the Harness.', '/harness/', 'voice, speech, microphone, audio'),
  task('files', 'chat', 'Ask your files', 'Add text or PDFs, ask questions and inspect the cited passages.', '/ask/', 'pdf, documents, rag, upload', true),
  task('encrypted', 'chat', 'Use encrypted chat', 'Follow the device-encryption setup for the attested gateway.', '/docs/#e2ee-phala', 'encrypted, encryption, e2ee'),
  task('history', 'chat', 'Organise your chats', 'Search, pin, rename, export or import chats in the Harness.', '/harness/', 'history, conversations, export, import'),
  task('install', 'chat', 'Install the app', 'Open the Harness and use browser installation on your phone or desktop.', '/harness/', 'pwa, mobile, phone, install'),
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

  task('rulebook', 'agents', 'Give an agent a budget', 'Set caps, models, lanes, tools and hours for requests through AnyRoute.', '/agents/', 'agent, rulebook, budget, limits', true),
  task('sessions', 'agents', 'Give an agent a session', 'Open Agent Sessions in the dashboard to set a session budget and lifetime.', '/dashboard/', 'agent sessions, session, ttl'),
  task('approvals', 'agents', "Approve an agent’s payment", 'Review how approvals work, then connect a key to approve or deny a request.', '/agents/', 'approval, approve, deny, payment', true),
  task('telegram', 'agents', 'Link Telegram approvals', 'Connect Telegram from Agents for approvals and alerts.', '/agents/', 'telegram, bot, notification'),
  task('activity', 'agents', 'Review agent activity', 'Open Activity for calls and agent events; Agents keeps the per-agent ledger.', '/dashboard/#activity', 'activity, ledger, receipts, csv, json'),
  task('alerts', 'agents', 'Set agent alerts', 'Configure the alert feed, spend webhook or linked Telegram notifications.', '/agents/', 'alerts, notification, webhook'),
  task('breakers', 'agents', 'Set circuit breakers', 'Configure rulebook breakers that stop subsequent requests through AnyRoute.', '/agents/', 'breaker, kill switch, stop, safety'),
  task('autonomy', 'agents', 'Adjust agent autonomy', 'Review progressive autonomy and spending caps for a selected agent.', '/agents/', 'autonomy, spending, caps'),
  task('certificates', 'agents', 'Check an agent’s track record', 'Read the router-signed certificate format, lifetime and verification limits.', '/docs/#agent-certificates', 'certificate, track record, reputation'),
  task('directory', 'agents', 'Find an agent', 'Browse opt-in public profiles and owner-supplied capabilities.', '/agents/directory/', 'directory, discover, agent card', true),
  task('profile', 'agents', 'Publish an agent profile', 'Manage an opt-in public profile and its rulebook summary.', '/agents/directory/', 'profile, publish, agent card'),
  task('agreements', 'agents', 'Make an agreement between agents', 'Select an agent, then Agreements to use USDG milestone escrow.', '/agents/', 'agreement, milestone, escrow, jury'),
  task('sealed', 'agents', 'Host a sealed agent', 'Read the hosting recipe; no sealed agent is registered on this site yet.', '/docs/#sealed-agents', 'sealed agent, hosting, sidecar, tdx'),

  task('network', 'network', 'See live network stats', 'Inspect host counts, available models, bonds and policy version.', '/network/', 'stats, network, capacity', true),
  task('join', 'network', 'Host hardware on the network', 'Join with the approved early-host build in a supported confidential VM.', '/network/#join', 'host, gpu, server, hardware, join', true),
  task('readiness', 'network', 'Check your hardware', 'Read and download the capability checker before joining.', '/network/#readiness', 'hardware, checker, tdx, sev, gpu'),
  task('hosts', 'network', 'Inspect host records', 'Inspect hardware checks, recorded builds and work roots for each host.', '/hosts/', 'hosts, records, attestation', true),
  task('bonds', 'network', 'Understand host bonds', 'Read the USDG bond requirements and current limits.', '/network/#bonds', 'bond, usdg, stake'),
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

  task('docs', 'learn', 'Read the docs', 'Browse guides and reference sections for AnyRoute tools.', '/docs/', 'documentation, guide, help', true),
  task('changelog', 'learn', "See what's new", 'Follow shipped changes with links to their pages and public commits.', '/changelog/', 'changelog, updates, shipped, rss, atom'), // V89: page, menu, footer and search.
  task('whitepaper', 'learn', 'Read the whitepaper', 'Read the architecture, payment design and routing model.', '/whitepaper/', 'whitepaper, paper, architecture', true),
  task('case-study', 'learn', 'Read the case study', 'Follow an application integration and its routing choices.', '/case-study/', 'case study, example, integration'),
  task('roadmap', 'learn', 'See the roadmap', 'See what is available and what comes next.', '/#roadmap', 'roadmap, planned, future'),
  task('about', 'learn', 'Learn about AnyRoute', 'Read the project’s purpose and approach.', '/#about', 'about, purpose, project'),
  task('privacy-notice', 'learn', 'Read the data notice', 'Read the site’s data-handling notice and privacy limits.', '/legal/privacy/', 'legal, privacy notice, data notice'),
  task('terms', 'learn', 'Read the terms', 'Read the terms for using AnyRoute.', '/legal/terms/', 'legal, terms, conditions'),
];

// Tools that live inside a page tab are found through search; menus, the mobile menu and the footer stay short.
const SEARCH_ONLY = new Set(['inbox', 'activity', 'history', 'unlinkable', 'proxy', 'registry', 'routing', 'presets', 'characters', 'batches', 'teams', 'tracing', 'playground', 'evals', 'skills', 'spend', 'api-receipts', 'holders', 'settings', 'sessions', 'breakers', 'autonomy', 'profile', 'inventory-log', 'badge', 'proof-time']);
SEARCH_ONLY.add('spec'); // V80: keep Build at nine menu tools; spec stays searchable.
for (const item of TASKS) item.menu = !SEARCH_ONLY.has(item.id);
TASKS.push({ ...task('chat-limits', 'chat', 'Limit chat spending', 'Open Harness Tools to cap spending, approve replies and stop chat.', '/harness/', 'limits, budget, spending, approval, stop'), menu: false }); // U77: search-only control.
TASKS.push({ ...task('rulebook-templates', 'agents', 'Start from a rulebook template', 'Review starter limits, then apply a rulebook to a selected agent.', '/agents/#rulebook-templates', 'starter, template, budget, rules'), menu: false }); // V85: search-only.
TASKS.push({ ...task('request-check', 'agents', 'Check a request against your rules', 'Check agent rules without spending: allow, approval required or deny.', '/agents/#request-check', 'check, try, request, rules'), menu: false }); // V85: search-only.
export const menuTasks = group => TASKS.filter(item => item.group === group && item.menu);

// Account sections share the task map; existing dashboard hashes remain stable.
export const ACCOUNT_GROUPS = [
  { title: 'Home', ids: ['dashboard', 'inbox'] },
  { title: 'Use', ids: ['playground', 'models', 'routing', 'presets', 'characters', 'evals', 'batches', 'skills'] },
  { title: 'Agents', ids: ['rulebook', 'sessions', 'directory'] },
  { title: 'Money', ids: ['account-activity', 'account-payments', 'holders', 'spend', 'api-receipts'] },
  { title: 'Account', ids: ['account-keys', 'teams', 'providers', 'settings', 'keep'] },
];
TASKS.push(task('account-keys', 'build', 'Manage account keys', 'Explore API keys, then connect to create keys and set budgets.', '/dashboard/#api-keys', 'api keys, budget'));
TASKS.push(task('account-payments', 'build', 'Add funds to your account', 'Explore Payments, then connect to see deposit instructions and your balance.', '/dashboard/#payments', 'balance, deposit'));
for (const id of ['account-keys', 'account-payments']) TASKS.find(item => item.id === id).menu = false;
const accountSection = (taskId, title, hash, description, start) => ({ taskId, title, hash, description, start, href: hash ? '/dashboard/#' + hash : TASKS.find(item => item.id === taskId).href });
export const ACCOUNT_SECTIONS = [
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

for (const section of ACCOUNT_SECTIONS) {
  const item = TASKS.find(task => task.id === section.taskId);
  if (section.hash && item.href === '/dashboard/') item.href = section.href;
}
