import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const pinned = /^.+@sha256:[0-9a-f]{64}$/;
export function renderSealedRecipe(env: Record<string,string|undefined>) {
  const agent = env.AGENT_IMAGE ?? '', sidecar = env.AGENT_SIDECAR_IMAGE ?? '';
  if (!pinned.test(agent) || !pinned.test(sidecar)) throw new Error('Both container images must use immutable sha256 digests.');
  const digest = agent.slice(agent.lastIndexOf('@') + 1);
  if (env.AGENT_IMAGE_DIGEST && env.AGENT_IMAGE_DIGEST !== digest) throw new Error('Agent image digest does not match the pinned image.');
  if (!/^[0-9a-f]{64}$/.test(env.AGENT_KEY_HASH ?? '')) throw new Error('Dedicated agent key fingerprint required.');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(env.AGENT_ATTEST_HOSTNAME ?? '')) throw new Error('Attestation hostname required.');
  const origin = new URL(env.AGENT_ROUTER_ORIGIN ?? 'https://anyroute.tech');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Router must be an HTTPS origin.');
  const values:Record<string,string> = {AGENT_IMAGE:agent,AGENT_SIDECAR_IMAGE:sidecar,AGENT_IMAGE_DIGEST:digest,AGENT_KEY_HASH:env.AGENT_KEY_HASH!,AGENT_ATTEST_HOSTNAME:env.AGENT_ATTEST_HOSTNAME!,AGENT_ROUTER_ORIGIN:origin.origin};
  const template = readFileSync(new URL('./docker-compose.template.yml',import.meta.url),'utf8');
  const text = template.replace(/\$\{([A-Z_]+)(?::[?-][^}]*)?\}/g,(_match,name) => JSON.stringify(values[name]));
  // JSON string quoting is valid YAML and excludes interpolation/injection from selected values.
  const composed = parse(text);
  if (composed.services.agent.image !== agent || composed.services.sidecar.environment.AGENT_IMAGE_DIGEST !== digest || /\$\{/.test(text)) throw new Error('Invalid rendered recipe.');
  return text;
}
if (import.meta.main) {
  try {process.stdout.write(renderSealedRecipe(process.env));}
  catch {process.stderr.write('Cannot render sealed recipe: check pinned images, key fingerprint, hostname and HTTPS origin.\n');process.exitCode=1;}
}
