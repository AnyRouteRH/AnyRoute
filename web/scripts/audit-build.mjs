import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]||'out');
const routes=['/','/models/','/harness/','/arena/','/docs/','/case-study/','/dashboard/','/verify/','/status/','/providers/','/registry/','/registry/_/','/legal/privacy/','/legal/terms/'];
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
console.log(`PASS: ${routes.length} routes; ${count} local asset/link references; no stray files.`);
