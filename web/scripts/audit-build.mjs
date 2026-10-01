import fs from 'node:fs';
import {auditNetwork} from './audit-network.mjs';
import {auditNetworkJoin} from './audit-network-join.mjs'; auditNetworkJoin(path.resolve(process.argv[2]||'out'));
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const root=path.resolve(process.argv[2]||'out');
const routes=['/','/models/','/harness/','/ask/','/arena/','/docs/','/case-study/','/dashboard/','/agents/','/verify/','/status/','/providers/','/registry/','/registry/_/','/legal/privacy/','/legal/terms/','/seal/','/tokens/','/keep/','/network/','/spec/','/hosts/',...(fs.existsSync(path.join(root,'spec'))?fs.readdirSync(path.join(root,'spec'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>`/spec/${d.name}/`):[])];
import {auditWhitepaper} from './audit-whitepaper.mjs'; routes.push('/whitepaper/'); auditWhitepaper(root);
routes.push('/agents/profile/', '/agents/directory/');
auditNetwork(root);
let count=0;
for(const route of routes){
 const file=path.join(root,route,'index.html');assert(fs.existsSync(file),`Missing route ${route}`);
 const html=fs.readFileSync(file,'utf8');assert(html.includes('Anyroute'),`Wrong brand ${route}`);
 for(const match of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[?#][^"]*)?"/g)){
  const value=match[1];if(value.startsWith('//'))continue;
  let target=path.join(root,decodeURIComponent(value));
  if(fs.existsSync(target)&&fs.statSync(target).isDirectory())target=path.join(target,'index.html');
  assert(fs.existsSync(target),`Missing ${value} from ${route}`);count++;
 }
 for(const match of html.matchAll(/href="(\/(?:[^"#]*))#([^"\s]+)"/g)){
  const [_,routePath,id]=match;const file=path.join(root,routePath,'index.html');
  if(fs.existsSync(file))assert(fs.readFileSync(file,'utf8').includes(`id="${id}"`),`Missing anchor ${routePath}#${id}`);
 }
 for(const match of html.matchAll(/href="#([^"\s]+)"/g))assert(html.includes(`id="${match[1]}"`),`Missing local anchor ${route}#${match[1]}`);
}
for(const name of fs.readdirSync(root))assert(!/\.(md|py|pdf|zip|map)$/i.test(name),`Unexpected file in the build: ${name}`);
// The single-file program at /private.mjs: present, a script, and its SHA-256 is the one the documentation page shows.
{const file=path.join(root,'private.mjs');assert(fs.existsSync(file),'Missing /private.mjs');const bytes=fs.readFileSync(file);
 assert(bytes.subarray(0,2).toString()==='#!'&&bytes.length>50_000,'/private.mjs is not the program');
 assert(fs.readFileSync(path.join(root,'docs','index.html'),'utf8').includes(crypto.createHash('sha256').update(bytes).digest('hex')),'The documentation page does not show the SHA-256 of /private.mjs');}
// The PDF reader on /ask/ (pdf.js): one on-demand chunk plus a worker file, both served from this site. It is reached only by a dynamic import
// when a PDF is added, so no page's own scripts may contain the reader, the loader (which names the worker) may sit only in /ask/'s scripts,
// and the worker must be the same version as the reader.
let pdfNote='';
{const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]):[];
 const staticDir=path.join(root,'_next','static');
 const scripts=new Map(walk(path.join(staticDir,'chunks')).filter(f=>/\.m?js$/.test(f)).map(f=>[f,fs.readFileSync(f,'utf8')]));
 const READER='Setting up fake worker failed',LOADER=/GlobalWorkerOptions\.workerSrc/;
 const readers=[...scripts].filter(([,t])=>t.includes(READER)).map(([f])=>f);
 assert(readers.length>=1,'The PDF reader chunk is missing from the build');
 const workers=walk(path.join(staticDir,'media')).filter(f=>/pdf\.worker\.min\.[^/\\]*\.mjs$/.test(f));
 assert(workers.length===1,`Expected one PDF worker file in the build, found ${workers.length}`);
 const worker=fs.readFileSync(workers[0],'utf8'),workerName=path.basename(workers[0]);
 const version=readers.map(f=>/apiVersion:"(\d+\.\d+\.\d+)"/.exec(scripts.get(f))?.[1]).find(Boolean);
 assert(version&&worker.includes(`"${version}"`)&&worker.length>500_000,`The PDF worker is not the reader's version (${version})`);
 assert(!/sourceMappingURL/.test(worker),'The PDF worker names a source map');
 for(const route of routes){
  const html=fs.readFileSync(path.join(root,route,'index.html'),'utf8');
  const files=[...new Set([...html.matchAll(/static\/(?:chunks|media)\/[^"'\\\s)<>]+?\.m?js/g)].map(m=>path.join(root,'_next',m[0])))];
  assert(!files.some(f=>readers.includes(f)||workers.includes(f)),`${route} loads the PDF reader up front`);
  let loader=false;
  for(const f of files){const t=scripts.get(f);if(!t)continue;
   assert(!t.includes(READER),`${route} carries the PDF reader in ${path.relative(root,f)}`);
   if(LOADER.test(t)||t.includes(workerName)){assert(route==='/ask/',`${route} carries the PDF loader in ${path.relative(root,f)}`);loader=true;}}
  if(route==='/ask/')assert(loader,'/ask/ does not carry the PDF loader');
 }
 const kib=n=>`${(n/1024).toFixed(0)} KiB`;
 pdfNote=` PDF reader ${version} on demand on /ask/ only (chunk ${kib(Math.max(...readers.map(f=>scripts.get(f).length)))}, worker ${kib(worker.length)}, own origin).`;
}
console.log(`PASS: ${routes.length} routes; ${count} local asset/link references; no stray files.${pdfNote}`);
