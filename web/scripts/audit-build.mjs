import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const root=path.resolve(process.argv[2]||'out');
const routes=['/','/models/','/harness/','/ask/','/arena/','/docs/','/case-study/','/dashboard/','/verify/','/status/','/providers/','/registry/','/registry/_/','/legal/privacy/','/legal/terms/','/seal/','/tokens/','/spec/',...(fs.existsSync(path.join(root,'spec'))?fs.readdirSync(path.join(root,'spec'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>`/spec/${d.name}/`):[])];
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
console.log(`PASS: ${routes.length} routes; ${count} local asset/link references; no stray files.`);
