import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {escapeHtml,extractRefs,parseBlocks,parseInline,plainText,renderInline,renderMarkdown,slugify,slugger,splitRow} from '../lib/spec-markdown.js';
import {listDocs,resolveSpecHref} from '../lib/seal-spec.js';

const SPEC=fileURLToPath(new URL('../../spec/',import.meta.url));
const md=(src,opts)=>renderMarkdown(src,opts).html;

test('headings get GitHub anchors: punctuation and code marks dropped, repeats numbered',()=>{
 assert.equal(slugify('3.1 anyroute-hpke/v1 (implemented)'),'31-anyroute-hpkev1-implemented');
 assert.equal(slugify('[0.1.0] - 2026-09-29'),'010---2026-09-29');
 assert.equal(slugify('Honest limits'),'honest-limits');
 const s=slugger();assert.deepEqual(['Added','Changed','Added','Added'].map(s),['added','changed','added-1','added-2']);
 const r=renderMarkdown('# Title\n\n## 3.1 `anyroute-hpke/v1` (implemented)\n\n### Added\n\n### Added\n',{stripTitle:true});
 assert.equal(r.title.text,'Title');assert.ok(!r.html.includes('<h1'));
 assert.match(r.html,/<h2 id="31-anyroute-hpkev1-implemented">3\.1 <code>anyroute-hpke\/v1<\/code> \(implemented\)<a class="heading-anchor" href="#31-anyroute-hpkev1-implemented"/);
 assert.deepEqual(r.headings.map(h=>h.id),['31-anyroute-hpkev1-implemented','added','added-1']);
 assert.match(md('# Kept\n'),/<h1 id="kept">/);
});

test('pipe tables: alignment, escaped pipes, pipes in code, padded rows, an empty header row left out',()=>{
 assert.deepEqual(splitRow('| a | `x | y` | b \\| c |'),['a','`x | y`','b \\| c']);
 const html=md('| L | C | R | N |\n| :--- | :---: | ---: | --- |\n| 1 | **2** | `3` |\n');
 assert.match(html,/<th scope="col" style="text-align:left">L<\/th><th scope="col" style="text-align:center">C<\/th><th scope="col" style="text-align:right">R<\/th><th scope="col">N<\/th>/);
 assert.match(html,/<td style="text-align:center"><strong>2<\/strong><\/td><td style="text-align:right"><code>3<\/code><\/td><td><\/td><\/tr>/);
 assert.match(md('| a | b \\| c |\n|---|---|\n| 1 | 2 |\n'),/<th scope="col">b \| c<\/th>/);
 const kv=md('| | |\n| :--- | :--- |\n| Status | Draft |\n');
 assert.ok(!kv.includes('<thead>'));assert.match(kv,/<td style="text-align:left">Status<\/td><td style="text-align:left">Draft<\/td>/);
 assert.match(kv,/^<div class="table-wrap" role="region" aria-label="Table" tabindex="0"><table>/);
});

test('lists: bullets, numbers with a start, loose items, nesting and continuation lines',()=>{
 assert.equal(md('* one\n* **two**: x\n- other\n'),'<ul><li>one</li><li><strong>two</strong>: x</li></ul>\n<ul><li>other</li></ul>');
 assert.equal(md('3. c\n4. d\n'),'<ol start="3"><li>c</li><li>d</li></ol>');
 assert.equal(md('1. a\n\n2. b\n'),'<ol><li><p>a</p></li><li><p>b</p></li></ol>');
 assert.equal(md('* a\n  * a1\n  * a2\n* b\n'),'<ul><li>a\n<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
 assert.equal(md('* a long item\n  that wraps\n* next\n'),'<ul><li>a long item\nthat wraps</li><li>next</li></ul>');
 assert.equal(md('Para:\n* item\n'),'<p>Para:</p>\n<ul><li>item</li></ul>');
});

test('fenced code is escaped verbatim with its language, never parsed as Markdown',()=>{
 const html=md('```json\n{ "a": "<hex>", "b": "**x** [y](z) | c" }\n```\n\n```\nplain\n```\n');
 assert.equal(html,'<div class="code-panel"><div class="code-bar"><span>json</span></div><pre tabindex="0"><code>{ &quot;a&quot;: &quot;&lt;hex&gt;&quot;, &quot;b&quot;: &quot;**x** [y](z) | c&quot; }</code></pre></div>\n<div class="code-panel"><div class="code-bar"><span>text</span></div><pre tabindex="0"><code>plain</code></pre></div>');
 assert.equal(parseBlocks('````\n```\n````\n')[0].text,'```');
});

test('inline: code, strong, emphasis, snake_case, links, references, bare addresses, escapes and HTML',()=>{
 assert.equal(renderInline('**S**idecar and `a || b` and *em* and _em_'),'<strong>S</strong>idecar and <code>a || b</code> and <em>em</em> and <em>em</em>');
 assert.equal(renderInline('snake_case_name and 2 * 3 * 4 and COSE_Sign1'),'snake_case_name and 2 * 3 * 4 and COSE_Sign1');
 assert.equal(renderInline('``code with ` tick``'),'<code>code with ` tick</code>');
 assert.equal(renderInline('[`0001-attestation.md`](0001-attestation.md)'),'<a href="0001-attestation.md"><code>0001-attestation.md</code></a>');
 assert.equal(renderInline('see [RFC2119] and [0.1.0]',{refs:{'0.1.0':'https://example.org/v'}}),'see [RFC2119] and <a href="https://example.org/v" rel="noopener noreferrer" target="_blank">0.1.0</a>');
 assert.equal(renderInline('at https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md. And (https://x.org/a_(b)).'),'at <a href="https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md" rel="noopener noreferrer" target="_blank">https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md</a>. And (<a href="https://x.org/a_(b)" rel="noopener noreferrer" target="_blank">https://x.org/a_(b)</a>).');
 assert.equal(renderInline('\\*not em\\* <script>&'),'*not em* &lt;script&gt;&amp;');
 assert.equal(renderInline('[x](javascript:alert(1))'),'x');
 assert.equal(renderInline('[a](b.md#c)',{resolveHref:h=>({href:'/r/'+h,external:false})}),'<a href="/r/b.md#c">a</a>');
 assert.equal(renderInline('[a](b)',{resolveHref:()=>null}),'a');
 assert.equal(plainText('**Attested execution.** A `x` [y](z)'),'Attested execution. A x y');
 assert.equal(escapeHtml('"<&>'),'&quot;&lt;&amp;&gt;');
 assert.deepEqual(parseInline('**unclosed'),[{type:'text',text:'**unclosed'}]);
});

test('blockquotes, rules and reference definitions',()=>{
 assert.equal(md('> quoted **text**\n> more\n\n---\n'),'<blockquote><p>quoted <strong>text</strong>\nmore</p></blockquote>\n<hr>');
 const {refs,text}=extractRefs('Top [v]\n\n[v]: https://example.org/v\n```\n[kept]: inside code\n```\n');
 assert.deepEqual(refs,{v:'https://example.org/v'});assert.match(text,/\[kept\]: inside code/);
 assert.equal(md('## [v] - 2026-01-01\n\n[v]: https://example.org/v\n'),'<h2 id="v---2026-01-01"><a href="https://example.org/v" rel="noopener noreferrer" target="_blank">v</a> - 2026-01-01<a class="heading-anchor" href="#v---2026-01-01" aria-label="Link to this section">#</a></h2>');
});

test('every spec file renders with no Markdown syntax left and every relative link rewritten',()=>{
 const docs=listDocs(SPEC);
 assert.ok(docs.length>=7,'README, five documents and the changelog');
 for(const doc of docs){
  const src=fs.readFileSync(SPEC+doc.file,'utf8');
  const {html,headings,title}=renderMarkdown(src,{stripTitle:true,resolveHref:h=>resolveSpecHref(h,docs)});
  assert.ok(title?.text,`${doc.file} has a title`);assert.ok(headings.length>2,`${doc.file} has sections`);
  // Text outside code blocks and code spans: nothing that should have been turned into markup.
  const text=html.replace(/<pre[\s\S]*?<\/pre>/g,'').replace(/<code>[\s\S]*?<\/code>/g,'').replace(/<a class="heading-anchor"[^>]*>#<\/a>/g,'').replace(/<[^>]+>/g,'\n');
  for(const raw of ['|---','| :--','**','](','`','```'])assert.ok(!text.includes(raw),`${doc.file} leaves ${raw} in the output`);
  assert.ok(!/^\s*#{1,6}\s/m.test(text),`${doc.file} leaves a heading marker`);
  assert.ok(!/^\s*\[[^\]]+\]:\s/m.test(text),`${doc.file} leaves a reference definition`);
  for(const [,para] of html.matchAll(/<p>([\s\S]*?)<\/p>/g))assert.ok(!/^\s*([*+-]|\d+\.)\s/m.test(para),`${doc.file} leaves a list marker in: ${para.slice(0,60)}`);
  // Tables in the source and in the output match one for one.
  const tables=src.replace(/```[\s\S]*?```/g,'').split('\n').filter(l=>/^\|\s*:?-/.test(l)).length;
  assert.equal((html.match(/<table>/g)||[]).length,tables,`${doc.file} tables`);
  // Links: other spec documents become /spec pages, repository paths go to GitHub, nothing relative is left.
  for(const [,href] of html.matchAll(/href="([^"]*)"/g)){
   assert.ok(/^(#|\/spec\/|https:\/\/|mailto:)/.test(href),`${doc.file} link ${href}`);
   assert.ok(!/\.md(#|$)/.test(href)||href.startsWith('https://github.com/'),`${doc.file} link ${href} points at a .md file`);
  }
  for(const [,id] of html.matchAll(/href="#([^"]+)"/g))assert.ok(html.includes(`id="${id}"`),`${doc.file} anchor #${id}`);
 }
});
