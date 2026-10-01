import { renderSealedRecipe } from '../deploy/agents/sealed/render.ts';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
test('sealed agent compose recipe parses and confines key access and external networking to sidecar',() => {
 const text=readFileSync(new URL('../deploy/agents/sealed/docker-compose.template.yml',import.meta.url),'utf8');
 const compose=parse(text);
 expect(Object.keys(compose.services).sort()).toEqual(['agent','sidecar']);
 expect(compose.networks.agent_private.internal).toBe(true);
 expect(compose.services.agent.networks).toEqual(['agent_private']);
 expect(compose.services.agent.environment.OPENAI_BASE_URL).toBe('http://sidecar:8788/v1');
 expect(compose.services.agent.ports).toBeUndefined();expect(compose.services.agent.volumes).toBeUndefined();
 expect(compose.services.sidecar.ports).toEqual(['8443:8443']);
 expect(compose.services.sidecar.volumes).toContain('agent_sealed:/sealed');
 for(const service of Object.values(compose.services) as any[]) {expect(service.privileged).toBeUndefined();expect(service.network_mode).toBeUndefined();expect(service.cap_drop).toEqual(['ALL']);expect(service.read_only).toBe(true);expect(service.image).toMatch(/\$\{.*IMAGE/);}
 expect(text).not.toMatch(/AGENT_API_KEY|OPENAI_API_KEY|Bearer /);
});

test('recipe renderer rejects mutable images and mismatched digests and produces materialized YAML',() => {
 const env={AGENT_IMAGE:'registry.example/agent@sha256:'+'ab'.repeat(32),AGENT_SIDECAR_IMAGE:'registry.example/sidecar@sha256:'+'cd'.repeat(32),AGENT_KEY_HASH:'ef'.repeat(32),AGENT_ATTEST_HOSTNAME:'agent.example'};
 const text=renderSealedRecipe(env), composed=parse(text);
 expect(text).not.toContain('${');expect(composed.services.agent.image).toBe(env.AGENT_IMAGE);expect(composed.services.sidecar.environment.AGENT_IMAGE_DIGEST).toBe('sha256:'+'ab'.repeat(32));
 expect(()=>renderSealedRecipe({...env,AGENT_IMAGE:'agent:latest'})).toThrow();
 expect(()=>renderSealedRecipe({...env,AGENT_IMAGE_DIGEST:'sha256:'+'ff'.repeat(32)})).toThrow();
 expect(()=>renderSealedRecipe({...env,AGENT_ROUTER_ORIGIN:'http://router.example'})).toThrow();
});
