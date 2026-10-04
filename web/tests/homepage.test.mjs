import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Render the composed homepage with the existing Bun toolchain.
const transpile='process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));';
const hook=registerHooks({
  resolve(specifier,context,next){
    if(specifier.startsWith('.')&&context.parentURL){
      for(const ext of ['.jsx','.js']){
        const url=new URL(specifier+ext,context.parentURL);
        if(fs.existsSync(url))return next(url.href,context);
      }
    }
    return next(specifier,context);
  },
  load(url,context,next){
    if(url.endsWith('.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({}, {get:(_,name)=>String(name)});'};
    if(url.endsWith('.jsx'))return {format:'module',shortCircuit:true,source:'import React from "react";\n'+execFileSync('bun',['-e',transpile],{input:fs.readFileSync(fileURLToPath(url),'utf8'),encoding:'utf8'})};
    return next(url,context);
  },
});
const {default:Home}=await import('../app/page.jsx');
const {Roadmap}=await import('../components/Extensions.jsx');
hook.deregister();
const html=renderToStaticMarkup(createElement(Home));
const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
const text=main.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

test('homepage content, header and footer link agents, network and hosts',()=>{
  const header=html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1];
  const footer=html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)[1];
  for(const section of [main,header,footer])for(const route of ['agents','network','hosts'])assert.match(section,new RegExp(`href="/${route}/"`));
  for(const anchor of ['e2ee-phala','agent-rulebook'])assert.ok(main.includes(`href="/docs/#${anchor}"`));
  assert.doesNotMatch(main,/href="\/api\//);
});

test('homepage describes the live rulebook and preserves enforcement and privacy limits',()=>{
  for(const phrase of ['per request, hour, day and week','models, lanes, tools and working hours','kill switch stops the next request; the owner resumes','Approve once on /agents within 15 minutes','signed receipts','CSV or JSON','alert feed','spend-alert webhook','Telegram via AnyRoute’s bot','Circuit breakers and progressive autonomy','spending caps up to 10x','fresh pseudonym','seven days','not anonymous','requests through AnyRoute only','router forwards ciphertext on this path','router reads request text in memory','not prompt or answer text'])assert.ok(text.includes(phrase),phrase);
  assert.doesNotMatch(main,/\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build|zero[- ]knowledge|can(?:not|’t|'t) read your prompts/i);
});

test('homepage states approved early-host admission and inactive payouts and slashing',()=>{
  for(const phrase of ['open for early hosts running the approved build','supported confidential VM','signed host policy v1','sanctions screening of operator and payout addresses','probation with a public record','Deposit required','Not switched on yet'])assert.ok(text.includes(phrase),phrase);
  assert.doesNotMatch(main,/\b(?:earn|yield|APY|passive income)\b|Hosting isn’t open yet/i);
});

test('roadmap separates available hosting and inactive agreements from the next steps',()=>{
  const roadmap=renderToStaticMarkup(createElement(Roadmap));
  assert.equal((roadmap.match(/class="live-square"><\/span>Live/g)||[]).length,4);
  const next=roadmap.match(/class="next-stage"[^>]*><span>(.*?)<\/span><b>Next<\/b>/)[1];
  assert.equal(next,'Agent wallets with on-chain rules; GPU hosts on the network; network payouts.');
  for(const phrase of ['Sealed agent hosting is available','no sealed agent is registered at anyroute.tech yet','Agreements between agents are live','jury of models on attested hardware'])assert.ok(roadmap.includes(phrase),phrase);
  assert.doesNotMatch(roadmap,/coming|contract deployment|live provider onboarding|\b20\d{2}\b|built and tested/i);
});

test('README includes the approved recipe, HostBond and resolvable docs anchors',()=>{
  const readme=fs.readFileSync('../README.md','utf8');
  assert.ok(readme.includes('0x2921d34fd86d3323a5369a270a82814a74250518'));
  assert.ok(fs.existsSync('../deploy/network/approved/tdx-qwen2.5-0.5b'));
  for(const route of ['agents','network','hosts'])assert.ok(readme.includes(`https://anyroute.tech/${route}/`));
  const docs=fs.readFileSync('app/docs/page.jsx','utf8')+fs.readdirSync('components').filter(n=>n.endsWith('Docs.jsx')).map(n=>fs.readFileSync(`components/${n}`,'utf8')).join('\n');
  for(const [,anchor] of readme.matchAll(/https:\/\/anyroute\.tech\/docs\/#([a-z0-9-]+)/g))assert.ok(docs.includes(`id="${anchor}"`),anchor);
  assert.doesNotMatch(readme,/\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build/i);
});


test('homepage and README describe the available profiles, sealed hosting, Telegram and stats',()=>{
  const readme=fs.readFileSync('../README.md','utf8');
  for(const content of [main,readme]) {
    for(const anchor of ['agent-profiles','sealed-agents','agent-approvals','network-stats'])assert.ok(content.includes(`/docs/#${anchor}`),anchor);
    for(const phrase of ['no sealed agent is registered','Approval details pass through Telegram','jury'])assert.ok(content.toLowerCase().includes(phrase.toLowerCase()),phrase);
    assert.doesNotMatch(content,/not deployed on mainnet|Telegram approvals[^.]*not switched on|sealed (?:agent )?hosting[^.]*is (?:also )?next/i);
  }
  for(const phrase of ['Agent profiles','A2A-style cards','Telegram approvals','router verifies a registered agent’s TDX quote'])assert.ok(text.includes(phrase),phrase);
  for(const phrase of ['100,000-token','No data yet','50/50','router-run model jury','trusted panel'])assert.ok(readme.includes(phrase),phrase);
});
