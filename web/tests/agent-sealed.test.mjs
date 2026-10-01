import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sealedLabel } from '../lib/agent-sealed.js';
test('badge only describes fresh hardware attestation with an image digest',()=>{
 const now=Date.now(), valid={attested:true,expires_at:new Date(now+30000).toISOString(),agent_image_digest:'sha256:'+'ab'.repeat(32)};
 assert.match(sealedLabel(valid,now),/^Sealed · attested · image sha256:/);
 for(const value of [null,{}, {...valid,attested:false},{...valid,expires_at:new Date(now).toISOString()},{...valid,agent_image_digest:'latest'}])assert.equal(sealedLabel(value,now),null);
});
test('sealed docs and API specify feature flag, measured trust and router plaintext limits',()=>{
 const docs=readFileSync(new URL('../components/SealedAgentDocs.jsx',import.meta.url),'utf8');
 for(const text of ['id="sealed-agents"','AGENT_SEALED_ENABLED defaults to false','Measured does not mean audited','read by the router in memory','does not establish exclusive possession'])assert.ok(docs.includes(text),text);
 assert.doesNotMatch(docs,/\b(demo|mock|simulated|placeholder)\b/i);
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 const route=api.paths['/api/v1/agents/{key_hash}/sealed'];assert.ok(route.post);assert.ok(route.delete);assert.ok(route.post.responses['422']);assert.equal(route.post.requestBody.content['application/json'].schema.additionalProperties,false);
});
