import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'out');
const port=Number(process.env.PORT||4281);
const mime={'.webmanifest':'application/manifest+json','.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4','.webp':'image/webp'};
http.createServer((req,res)=>{let p;try{p=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400);res.end();return}let f=path.resolve(root,'.'+p);if(f!==root&&!f.startsWith(root+path.sep)){res.writeHead(403);res.end();return}if(!fs.existsSync(f)&&/^\/registry\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/?$/.test(p))f=path.join(root,'registry','_');if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');if(!fs.existsSync(f)&&fs.existsSync(f+'.html'))f+='.html';if(!fs.existsSync(f)){res.writeHead(404);res.end('Not found');return}res.setHeader('Content-Type',mime[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(res);}).listen(port,'127.0.0.1',()=>console.log(`Preview http://127.0.0.1:${port}`));
