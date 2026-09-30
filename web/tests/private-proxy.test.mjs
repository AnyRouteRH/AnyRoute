import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {privateProgram,privateProgramFile} from '../lib/private-proxy.js';

const served=new URL('../public/private.mjs',import.meta.url);
const component=fs.readFileSync(new URL('../components/PrivateProxyDocs.jsx',import.meta.url),'utf8');
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const pkg=JSON.parse(fs.readFileSync(new URL('../../packages/private/package.json',import.meta.url),'utf8'));

test('the SHA-256 on the page is computed from the file the site serves',()=>{
 const bytes=fs.readFileSync(served);
 const program=privateProgram(served);
 assert.equal(program.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 assert.equal(program.bytes,bytes.length);
 assert.equal(program.version,pkg.version);
 assert.match(program.sha256,/^[0-9a-f]{64}$/);
 assert.ok(privateProgramFile('/somewhere').endsWith('/somewhere/public/private.mjs'));
});

test('a missing file stops the build instead of publishing a page that names it',()=>{
 assert.throws(()=>privateProgram(new URL('../public/absent.mjs',import.meta.url)));
});

test('the docs page lists the section, links it from the contents and renders it once',()=>{
 assert.match(docs,/<a href="#private">Private proxy<\/a>/);
 assert.equal(docs.match(/<PrivateProxyDocs \/>/g)?.length,1);
 assert.match(component,/<h2 id="private">Make any AI app private in one command\.<\/h2>/);
 for(const id of ['private-get','private-use','private-does','private-apps','private-tokens'])assert.match(component,new RegExp(`id="${id}"`));
});

test('it says what is not hidden, in plain words, and claims nothing the code does not do',()=>{
 assert.match(component,/The router still reads every prompt/);
 assert.match(component,/who sent the call and who paid for\s+it/);
 assert.match(component,/Encryption through the router to the enclave is planned, not built/);
 assert.match(component,/private\.mjs/);
 assert.match(component,/id="private-sha256"/);
 assert.match(component,/refuses to start unless a Tor client\s+answers/);
 for(const claim of [/cannot read your prompt/i,/no logs/i,/zero[- ]knowledge/i,/untraceable/i,/fully anonymous/i,/end-to-end encrypted/i])assert.doesNotMatch(component,claim);
 // What the program does not serve is said, not left for the reader to find out.
 assert.match(component,/Claude Code and the Anthropic SDKs can use POST \/v1\/messages with blind tokens/);
 assert.match(component,/The Responses API is not supported by this proxy/);
});

test('the public copy avoids the words the site does not use for its own product',()=>{
 for(const word of [/\bdemo\b/i,/\bmock/i,/\bsimulat/i,/\bplaceholder/i,/\blocal build/i,/\btest(s|ed|ing)?\b/i])assert.doesNotMatch(component,word);
});

test('the command line in the docs matches what the program accepts',()=>{
 const help=fs.readFileSync(served,'utf8');
 for(const flag of ['--count','--denomination','--port','--socks','--onion','--local-key','--shared-circuit'])assert.ok(help.includes(flag),flag);
 for(const flag of ['--local-key','--shared-circuit','--socks','--onion','--denomination'])assert.ok(component.includes(flag),`${flag} is documented`);
});
