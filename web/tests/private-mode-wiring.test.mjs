import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the Harness page is wired to the switch: header on every chat request, the strip and the label under replies',()=>{
 const src=fs.readFileSync(new URL('../components/Harness.jsx',import.meta.url),'utf8');
 assert.match(src,/headers:\s*\{[^}]*\.\.\.priv\.headers\(\)/,'chat requests must add the lane header');
 assert.match(src,/<PrivateMode\b/);
 assert.match(src,/<ReplyPrivacy\b/);
 assert.match(src,/priv\.on\s*\?\s*priv\.models\s*:\s*raw/,'the model list must come from the attested list while the switch is on');
});
