import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { agentReportData, hash } from '../src/agent/bindings.ts';
import { agentConfig, bootAgent, proxyAgent } from '../src/agent/runtime.ts';
import { deriveSealingKey, openCredential, persistCredential, readCredential, sealCredential } from '../src/agent/credential-store.ts';
import { parseTdxQuote } from '../src/attestation/tdx-quote.ts';
import { DevAttestationProvider } from '../src/attestation/dev.ts';
import { cleanup, dstackProvider, tmpDir } from './helpers.ts';
import { afterEach } from 'bun:test';
afterEach(cleanup);
const compose='sha256:'+'cd'.repeat(32), secret='fixture-agent-credential', fingerprint=hash(secret);
const cfg={imageDigest:'sha256:'+'ab'.repeat(32),keyHash:fingerprint,socket:'/var/run/dstack.sock',credentialFile:'/sealed/api-credential.bin',routerOrigin:'https://router.example',hostname:'agent.example'};
test('existing dstack provider binds every deployment field, key fingerprint, TLS and nonce',async () => {
 const rt=await bootAgent(cfg,dstackProvider({composeHash:compose}),async () => secret), nonce='12'.repeat(32);
 const doc=await rt.attest(nonce);
 expect(doc.evidence.dev).toBe(false);
 expect(doc.bindings.agent_key_hash).toBe(fingerprint);
 expect(doc.bindings.tls_spki_sha256).toBe(hash(rt.tls.spkiDer));
 expect(parseTdxQuote(Buffer.from(doc.evidence.quote,'hex')).reportData).toBe(agentReportData(rt.bindings,nonce).toString('hex'));
 for(const [field,value] of [['agent_key_hash','ff'.repeat(32)],['agent_image_digest','sha256:'+'ff'.repeat(32)],['compose_hash','sha256:'+'ff'.repeat(32)],['sidecar_version','other'],['tls_spki_sha256','ff'.repeat(32)]]) expect(agentReportData({...rt.bindings,[field]:value},nonce).toString('hex')).not.toBe(doc.evidence.reportData);
 await expect(rt.attest('bad')).rejects.toThrow();
});
test('hardware boot rejects development providers, missing measurements and wrong credentials',async () => {
 await expect(bootAgent(cfg,new DevAttestationProvider(),async () => secret)).rejects.toThrow();
 await expect(bootAgent(cfg,dstackProvider(),async () => secret)).rejects.toThrow();
 await expect(bootAgent(cfg,dstackProvider({composeHash:compose}),async () => 'other')).rejects.toThrow();
 await expect(bootAgent(cfg,dstackProvider({composeHash:compose,badReportData:true}),async () => secret)).rejects.toThrow();
});
test('KMS derivation uses a compose-scoped path, guest socket and no network fallback',async () => {
 const key=randomBytes(32); let seen:any;
 const keyFetch=(async (url:any,init:any) => {seen={url,init};return Response.json({key:key.toString('hex')});}) as unknown as typeof fetch;
 expect(await deriveSealingKey(cfg.socket,compose,keyFetch)).toEqual(key);
 expect(seen.url).toBe('http://dstack/GetKey');expect(seen.init.unix).toBe(cfg.socket);
 expect(JSON.parse(seen.init.body).path).toContain(compose);
 await expect(deriveSealingKey('https://remote.example',compose,keyFetch)).rejects.toThrow();
 await expect(deriveSealingKey(cfg.socket,compose,(async()=>Response.json({key:'bad'})) as unknown as typeof fetch)).rejects.toThrow();
});
test('sealed credential survives restart; other key, compose, fingerprint and tampering are refused',async () => {
 const key=randomBytes(32), file=tmpDir()+'/credential.bin';
 const sealed=sealCredential(key,compose,secret);expect(sealed.includes(Buffer.from(secret))).toBe(false);
 await persistCredential(file,sealed);
 expect(openCredential(key,compose,await readCredential(file),fingerprint)).toBe(secret);
 expect(openCredential(key,compose,sealed,fingerprint)).toBe(secret);
 expect(()=>openCredential(randomBytes(32),compose,sealed,fingerprint)).toThrow();
 expect(()=>openCredential(key,'sha256:'+'ff'.repeat(32),sealed,fingerprint)).toThrow();
 expect(()=>openCredential(key,compose,sealed,'ff'.repeat(32))).toThrow();
 sealed[15]^=1;expect(()=>openCredential(key,compose,sealed,fingerprint)).toThrow();
});
test('proxy uses only fixed HTTPS origin, replaces credentials and preserves streams and receipt headers',async () => {
 let seen:any;
 const proxy=proxyAgent(secret,cfg.routerOrigin,(async (url:any,init:any)=>{seen={url,init};expect(await new Response(init.body).text()).toBe('{"messages":[]}');return new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream','x-receipt-id':'receipt','x-anyroute-lane':'attested','x-anyroute-policy-hash':'policy'}});}) as unknown as typeof fetch);
 const res=await proxy(new Request('http://sidecar/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer agent-label',cookie:'private','x-agent-approval':'approval','x-anyroute-lane':'attested','content-type':'application/json'},body:'{"messages":[]}'}));
 expect(seen.url).toBe(cfg.routerOrigin+'/api/v1/chat/completions');expect(seen.init.redirect).toBe('error');expect(seen.init.headers.get('authorization')).toBe('Bearer '+secret);expect(seen.init.headers.has('cookie')).toBe(false);expect(seen.init.headers.get('x-agent-approval')).toBe('approval');
 expect(res.headers.get('x-receipt-id')).toBe('receipt');expect(res.headers.get('x-anyroute-policy-hash')).toBe('policy');expect(await res.text()).toContain('[DONE]');
 expect((await proxy(new Request('http://sidecar/v1/keys'))).status).toBe(404);
 expect((await proxy(new Request('http://sidecar/v1/models?redirect=https://other.example'))).status).toBe(404);
});
test('agent runtime config refuses mutable digests and insecure or path-bearing router origins',() => {
 const env={AGENT_IMAGE_DIGEST:cfg.imageDigest,AGENT_KEY_HASH:fingerprint,AGENT_ATTEST_HOSTNAME:cfg.hostname};
 expect(agentConfig(env).routerOrigin).toBe('https://anyroute.tech');
 for(const AGENT_ROUTER_ORIGIN of ['http://router.example','https://user:secret@router.example','https://router.example/api','https://router.example/?secret=x'])expect(()=>agentConfig({...env,AGENT_ROUTER_ORIGIN})).toThrow();
 expect(()=>agentConfig({...env,AGENT_IMAGE_DIGEST:'latest'})).toThrow();
});
