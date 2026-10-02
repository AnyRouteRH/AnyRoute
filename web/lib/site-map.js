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
  task('models', 'chat', 'Find models and prices', 'Browse the model catalog, providers and per-token rates.', '/models/', 'catalog, pricing, cost, models'),

  task('dashboard', 'build', 'Manage your API keys', 'Open the dashboard to connect an account and manage keys.', '/dashboard/', 'dashboard, api key, account', true),
  task('api', 'build', 'Call the API', 'Read request formats, endpoints and the quickstart.', '/docs/#quickstart', 'api, integration, developer', true),
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
  task('api-receipts', 'build', 'Review your API calls', 'Open Receipts in the dashboard to inspect recorded calls.', '/dashboard/', 'api receipts, calls, history'),
  task('holders', 'build', 'Inspect $ANYR account benefits', 'Open Holders in the dashboard to inspect balance, tier and credit details.', '/dashboard/', 'holders, tier, balance, anyr'),
  task('settings', 'build', 'Set account preferences', 'Open Settings in the dashboard to manage account preferences.', '/dashboard/', 'settings, account, preferences'),
  task('mcp', 'build', 'Connect agent tools', 'Read the MCP tool interface and connection instructions.', '/docs/#mcp', 'mcp, tools, agent'),

  task('rulebook', 'agents', 'Give an agent a budget', 'Set caps, models, lanes, tools and hours for requests through AnyRoute.', '/agents/', 'agent, rulebook, budget, limits', true),
  task('sessions', 'agents', 'Give an agent a session', 'Open Agent Sessions in the dashboard to set a session budget and lifetime.', '/dashboard/', 'agent sessions, session, ttl'),
  task('approvals', 'agents', "Approve an agent’s payment", 'Connect your key on Agents to approve or deny a single-use request.', '/agents/', 'approval, approve, deny, payment', true),
  task('telegram', 'agents', 'Link Telegram approvals', 'Connect Telegram from Agents for approvals and alerts.', '/agents/', 'telegram, bot, notification'),
  task('activity', 'agents', 'Review agent activity', 'Select an agent, then Activity & receipts to inspect or export its ledger.', '/agents/', 'activity, ledger, receipts, csv, json'),
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
  task('whitepaper', 'learn', 'Read the whitepaper', 'Read the architecture, payment design and routing model.', '/whitepaper/', 'whitepaper, paper, architecture', true),
  task('case-study', 'learn', 'Read the case study', 'Follow an application integration and its routing choices.', '/case-study/', 'case study, example, integration'),
  task('roadmap', 'learn', 'See the roadmap', 'See what is available and what comes next.', '/#roadmap', 'roadmap, planned, future'),
  task('about', 'learn', 'Learn about AnyRoute', 'Read the project’s purpose and approach.', '/#about', 'about, purpose, project'),
  task('privacy-notice', 'learn', 'Read the data notice', 'Read the site’s data-handling notice and privacy limits.', '/legal/privacy/', 'legal, privacy notice, data notice'),
  task('terms', 'learn', 'Read the terms', 'Read the terms for using AnyRoute.', '/legal/terms/', 'legal, terms, conditions'),
];

// Tools that live inside a page tab are found through search; menus, the mobile menu and the footer stay short.
const SEARCH_ONLY = new Set(['history', 'unlinkable', 'proxy', 'registry', 'routing', 'presets', 'characters', 'batches', 'teams', 'tracing', 'playground', 'evals', 'skills', 'spend', 'api-receipts', 'holders', 'settings', 'sessions', 'breakers', 'autonomy', 'profile', 'inventory-log', 'badge', 'proof-time']);
for (const item of TASKS) item.menu = !SEARCH_ONLY.has(item.id);
export const menuTasks = group => TASKS.filter(item => item.group === group && item.menu);
