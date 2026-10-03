import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const index = read('components/DocsFeatureIndex.jsx');
const transpiled = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: index, encoding: 'utf8' });
const { DocsFeatureIndex, DocsFeatureLinks } = new Function('React', transpiled
  .replace('export default function DocsFeatureIndex', 'function DocsFeatureIndex')
  .replace('export function DocsFeatureLinks', 'function DocsFeatureLinks') + '\nreturn {DocsFeatureIndex, DocsFeatureLinks};')({ createElement });

const sections = {
  'agent-rulebook': 'AgentRulebookDocs', 'agent-approvals': 'AgentApprovalDocs',
  'agent-breakers': 'AgentBreakersDocs', 'agent-autonomy': 'AgentAutonomyDocs',
  'agent-ledger': 'AgentLedgerDocs', 'agent-alerts': 'AgentAlertDocs',
  'agent-profiles': 'AgentProfileDocs', 'agent-identity': 'AgentIdentityDocs', 'sealed-agents': 'SealedAgentDocs',
  'network-stats': 'NetworkStatsDocs', 'agreements': 'AgreementsDocs', 'agent-certificates': 'AgentCertificateDocs', 'e2ee-phala': 'E2eeDocs',
  'network-host-signup': 'NetworkHostsDocs', 'network-host-policy': 'NetworkPolicyDocs',
  'network-payouts': 'NetworkPayoutDocs', 'host-bonds': 'HostBondsDocs',
  'commerce-stats': 'CommerceStatsDocs', // v6 L
};

test('/docs feature index and side navigation link every agent, encrypted-chat and network section', () => {
  const page = read('app/docs/page.jsx');
  assert.match(page, /<nav[^>]*aria-label="Documentation sections"[\s\S]*?<DocsFeatureLinks \/>[\s\S]*?<\/nav>/);
  assert.ok(page.indexOf('<DocsFeatureIndex />') < page.indexOf('<AgentRulebookDocs />'));
  const featureHtml = renderToStaticMarkup(createElement(DocsFeatureIndex));
  const navHtml = renderToStaticMarkup(createElement(DocsFeatureLinks));
  for (const [id, component] of Object.entries(sections)) {
    for (const html of [featureHtml, navHtml]) assert.ok(html.includes(`href="#${id}"`), id);
    assert.ok(read(`components/${component}.jsx`).includes(`id="${id}"`), `${id} exists`);
    assert.equal(page.split(`<${component} />`).length - 1, 1, `${component} rendered once`);
  }
});

test('hosted enablement keeps self-host defaults and accurately separates unavailable features', () => {
  for (const component of Object.values(sections).filter(name => !['E2eeDocs', 'HostBondsDocs', 'NetworkPayoutDocs', 'AgreementsDocs', 'SealedAgentDocs', 'AgentIdentityDocs'].includes(name))) {
  for (const component of Object.values(sections).filter(name => !['E2eeDocs', 'HostBondsDocs', 'NetworkPayoutDocs', 'AgreementsDocs', 'SealedAgentDocs', 'CommerceStatsDocs'].includes(name))) {
    const docs = read(`components/${component}.jsx`);
    assert.match(docs, /default(?:s to)? false/);
    assert.match(docs, /Switched on at anyroute.tech\./);
  }
  assert.match(read('components/AgreementsDocs.jsx'), /deployed on Robinhood Chain/);
  assert.match(read('components/AgreementsDocs.jsx'), /Automatic jury rulings are switched on/);
  assert.match(read('components/SealedAgentDocs.jsx'), /AGENT_SEALED_ENABLED defaults to false/);
  assert.match(read('components/AgentIdentityDocs.jsx'), /default to false/);
  assert.match(read('components/AgentIdentityDocs.jsx'), /Not switched on at anyroute.tech yet\./);
  assert.match(read('components/CommerceStatsDocs.jsx'), /it defaults to false and is not switched on at anyroute.tech yet/); // v6 L
  assert.match(read('components/SealedAgentDocs.jsx'), /hosting is available at anyroute.tech, but no sealed agent is registered there yet/);
  const featureHtml = renderToStaticMarkup(createElement(DocsFeatureIndex));
  for (const phrase of ['Telegram linking and approvals', 'opt-in public profiles', 'no sealed agent is registered', 'escrow and dispute contracts deployed on Robinhood Chain', 'Live network statistics', 'Agent agreements · live, with jury rulings']) assert.ok(featureHtml.includes(phrase), phrase);
  const bonds = read('components/NetworkBondsNote.jsx');
  assert.match(bonds, /https:\/\/robinhoodchain.blockscout.com\/address\/0x2921d34fd86d3323a5369a270a82814a74250518/);
  assert.match(bonds, /minimum is 5,000 USDG/);
  assert.match(bonds, /Payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet/);
  assert.match(read('app/network/NetworkContent.jsx'), /<NetworkBondsNote \/>/);
  assert.match(read('components/NetworkPayoutDocs.jsx'), /No payouts are being made/);
  assert.match(read('components/AgentApprovalDocs.jsx'), /Telegram linking and approvals are switched on at anyroute\.tech/);
  assert.match(read('components/AgentAlertDocs.jsx'), /Email alerts are not switched on/);
});

test('SEAL specifies implemented admission and encrypted chat separately from planned sidecar transport', () => {
  const specRead = path => readFileSync(new URL(`../../spec/${path}`, import.meta.url), 'utf8');
  const attestation = specRead('0001-attestation.md');
  for (const phrase of ['SHA-256 sidecar bindings v2', 'explicit `v: 1`', 'Signed host admission policy', '`host_policy`', 'Ed25519', 'Versions MUST start at 1', 'Development evidence MUST always be refused']) assert.ok(attestation.includes(phrase), phrase);
  const readme = specRead('README.md');
  assert.match(readme, /Encrypted chat adapter[^\n]*Implemented, off by default/);
  assert.match(readme, /Sidecar `anyroute-hpke\/v1` ciphertext[^\n]*Planned/);
  const seal = read('app/seal/page.jsx');
  for (const component of ['SealNetworkDocs', 'SealEncryptedChatDocs']) assert.ok(seal.includes(`<${component} />`));
  assert.match(read('components/SealEncryptedChatDocs.jsx'), /Ordinary chat reads request text in router memory on every lane/);
});

test('integration and SDK documentation names both agent MCP tools and unpublished SDK releases', () => {
  const registry = readFileSync(new URL('../../integrations/mcp-registry/README.md', import.meta.url), 'utf8');
  for (const phrase of ['anyroute_agent_rules', 'anyroute_agent_check', 'eight tools', 'both agent tools need an API key']) assert.ok(registry.includes(phrase), phrase);
  for (const [folder, name] of [['client', 'npm'], ['client-py', 'PyPI']]) {
    const docs = readFileSync(new URL(`../../packages/${folder}/README.md`, import.meta.url), 'utf8');
    assert.ok(docs.includes(`${name} release is not published yet`));
    for (const path of ['/api/v1/agents/me', '/api/v1/agents/check']) assert.ok(docs.includes(path));
  }
});
