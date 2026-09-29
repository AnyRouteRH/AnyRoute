import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ANYR_ATTESTED_LINE,STEPS,creditEstimate,depositView,depositsOf,erc20BalanceData,erc20TransferData,formatUnits,formatUsd,isAddress,newlyCredited,pollInterval,rateView,stageOf,toRawAmount,tokensPerDollar} from '../lib/anyr-pay.js';
import {MAX_VERSION,capacity,formatBits,qrMatrix,qrPath} from '../lib/qr.js';

const ESCROW='0x00000000000000000000000000000000000e5c20';
const ANYR='0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a';

// Real responses of GET /api/v1/escrow/anyr/price, produced by the router over RPC responses recorded from
// the public Robinhood Chain RPC (test/fixtures/anyr-twap-swinging.json.gz): once with the default 5% guard
// (the pool's spot price was 18% above its 30-minute average, so there is no price) and once with a 25% guard.
const NO_PRICE={"enabled":true,"symbol":"ANYR","address":"0xa4ddf89a40a35264e9d7f896a1ef01c59b1e977a","decimals":18,"source":"twap","window_minutes":30,"max_deviation":0.05,"haircut_bps":0,"max_usd_per_deposit":250,"available":false,"price_usd":null,"credit_usd_per_token":null,"spot_usd":null,"average_usd":null,"window_seconds":null,"swaps":null,"block":null,"updated_at":null,"checked_at":"2026-09-29T17:38:02.570Z","reason":{"code":"price_swinging","message":"The ANYR pool price is 18% above its 30-minute average; deposits are credited only while the two are within 5%. Deposits wait and are credited automatically once the price settles.","deviation":0.1766628287363632,"limit":0.05,"direction":"above"}};
const PRICED={"enabled":true,"symbol":"ANYR","address":"0xa4ddf89a40a35264e9d7f896a1ef01c59b1e977a","decimals":18,"source":"twap","window_minutes":30,"max_deviation":0.25,"haircut_bps":0,"max_usd_per_deposit":250,"available":true,"price_usd":8.239212e-05,"credit_usd_per_token":8.239212e-05,"spot_usd":9.688021282088267e-05,"average_usd":8.239212088846077e-05,"window_seconds":1908,"swaps":907,"block":75836052,"updated_at":"2026-09-29T17:38:02.000Z","checked_at":"2026-09-29T17:38:02.574Z","reason":null};
const ESCROW_INFO={enabled:true,address:ESCROW,chain_id:4663,explorer:'https://robinhoodchain.blockscout.com',finality:'finalized',confirmations:2,expected_credit_delay_s:420,head_block:'75836100',credit_block:'75832400'};

// ---------------------------------------------------------------- amounts and calldata

test('amounts convert to raw units exactly and refuse what cannot be sent',()=>{
 assert.equal(toRawAmount('1',18),10n**18n);
 assert.equal(toRawAmount('1000.5',18),1000500000000000000000n);
 assert.equal(toRawAmount(' .25 ',18),250000000000000000n);
 assert.equal(toRawAmount('0.000000000000000001',18),1n);
 assert.equal(toRawAmount('12',0),12n);
 for(const bad of ['','.','abc','1e3','-1','1,000','1.2.3','0x10'])assert.throws(()=>toRawAmount(bad,18),/amount as a number/,bad);
 assert.throws(()=>toRawAmount('0.0000000000000000001',18),/at most 18 decimal places/);
 assert.throws(()=>toRawAmount('1.5',0),/at most 0 decimal places/);
});

test('raw units format for display without floating point',()=>{
 assert.equal(formatUnits(1234567890000000000000n,18),'1,234.5678');
 assert.equal(formatUnits(1234567890000000000000n,18,2),'1,234.56');
 assert.equal(formatUnits(10n**18n,18),'1');
 assert.equal(formatUnits(0n,18),'0');
 assert.equal(formatUnits(999n,18),'0');
 assert.equal(formatUnits('5000000000000000000000000',18,0),'5,000,000');
 assert.equal(formatUnits(1n,18,18),'0.000000000000000001');
});

test('the ERC-20 transfer the wallet signs is transfer(escrow, amount) and nothing else',()=>{
 // Selector a9059cbb, the escrow address left-padded to 32 bytes, then 1 ANYR (10^18 = 0xde0b6b3a7640000).
 assert.equal(erc20TransferData(ESCROW,10n**18n),'0xa9059cbb'+'0'.repeat(24)+'00000000000000000000000000000000000e5c20'.slice(0)+'0'.repeat(49)+'de0b6b3a7640000');
 assert.equal(erc20TransferData(ESCROW,10n**18n).length,2+8+64+64);
 assert.equal(erc20TransferData(ANYR,1n),'0xa9059cbb'+'0'.repeat(24)+ANYR.slice(2).toLowerCase()+'0'.repeat(63)+'1');
 assert.equal(erc20TransferData(ESCROW,'255'),erc20TransferData(ESCROW,255n),'decimal strings are accepted');
 assert.throws(()=>erc20TransferData('0x123',1n),/not an address/);
 assert.throws(()=>erc20TransferData(ESCROW.slice(0,-1)+'g',1n),/not an address/);
 assert.throws(()=>erc20TransferData(ESCROW,0n),/above zero/);
 assert.throws(()=>erc20TransferData(ESCROW,-1n),/above zero/);
 assert.throws(()=>erc20TransferData(ESCROW,1n<<256n),/too large/);
 assert.equal(erc20BalanceData(ESCROW),'0x70a08231'+'0'.repeat(24)+ESCROW.slice(2));
 assert.equal(isAddress(ANYR),true);
 assert.equal(isAddress('0x'+'g'.repeat(40)),false);
 assert.equal(isAddress(undefined),false);
});

test('dollar amounts show cents above a dollar and four significant digits below',()=>{
 assert.equal(formatUsd(250),'$250.00');
 assert.equal(formatUsd(1234.5),'$1,234.50');
 assert.equal(formatUsd(0.5),'$0.50');
 assert.equal(formatUsd(0.0123456),'$0.0123');
 assert.equal(formatUsd(8.239212e-05),'$0.00008239');
 assert.equal(formatUsd(1e-7),'$0.0000001');
 assert.equal(formatUsd(0),'$0');
 assert.equal(formatUsd(NaN),'—');
 assert.equal(tokensPerDollar(8.239212e-05),'12,137');
 assert.equal(tokensPerDollar(0),null);
});

// ---------------------------------------------------------------- the rate

test('the live rate reads as credits per token, with its window, spot and average, from the real endpoint output',()=>{
 const v=rateView(PRICED);
 assert.equal(v.state,'live');
 assert.equal(v.headline,'1 ANYR = $0.00008239 in credits');
 assert.match(v.detail,/lower of the pool's spot price and its 30-minute average/);
 assert.match(v.detail,/no haircut/);
 assert.match(v.detail,/\$250\.00 each/);
 assert.equal(v.perDollar,'12,137');
 assert.equal(v.spot,PRICED.spot_usd);
 assert.equal(v.average,PRICED.average_usd);
 assert.equal(v.swaps,907);
 assert.equal(v.windowSeconds,1908);
 assert.match(rateView({...PRICED,haircut_bps:300}).detail,/after a 3% haircut/);
});

test('no price is said out loud, with the router\'s reason, and a transfer is not blocked outright',()=>{
 const v=rateView(NO_PRICE);
 assert.equal(v.state,'unavailable');
 assert.equal(v.headline,'No ANYR price right now');
 assert.equal(v.detail,NO_PRICE.reason.message);
 assert.equal(v.code,'price_swinging');
 assert.equal(v.rate,null);
 assert.match(v.note,/credited automatically at the price in effect when it clears/);
 // A reason-less or malformed answer still says something honest.
 assert.match(rateView({enabled:true,symbol:'ANYR',available:false}).detail,/could not be read/);
 assert.equal(rateView({...PRICED,credit_usd_per_token:0}).state,'unavailable');
 assert.equal(rateView(undefined).state,'loading');
 assert.equal(rateView(null).state,'loading');
 assert.equal(rateView({enabled:false}).state,'off');
});

test('the credit estimate follows the rate, the per-deposit limit and exact amounts',()=>{
 const rate=PRICED.credit_usd_per_token;
 const e=creditEstimate({amountText:'1000',decimals:18,rate,limit:250});
 assert.equal(e.ok,true);
 assert.equal(e.raw,1000n*10n**18n);
 assert.ok(Math.abs(e.credit-1000*rate)<1e-12);
 assert.equal(e.capped,false);
 // 5,000,000 ANYR is about $412: capped at the limit, and the largest single deposit is named.
 const big=creditEstimate({amountText:'5000000',decimals:18,rate,limit:250});
 assert.equal(big.capped,true);
 assert.equal(big.credit,250);
 assert.ok(big.value>250);
 assert.equal(big.maxTokens,Math.floor(250/rate));
 assert.equal(creditEstimate({amountText:'3034000',decimals:18,rate,limit:250}).capped,false,'just under the limit');
 assert.equal(creditEstimate({amountText:'3035000',decimals:18,rate,limit:250}).capped,true,'just over the limit');
 // No price: the amount is still checked and the credit is unknown.
 assert.deepEqual({...creditEstimate({amountText:'10',decimals:18,rate:null,limit:250}),raw:undefined},{ok:true,raw:undefined,credit:null,capped:false,maxTokens:null});
 assert.equal(creditEstimate({amountText:'0',decimals:18,rate,limit:250}).ok,false);
 assert.match(creditEstimate({amountText:'abc',decimals:18,rate,limit:250}).error,/as a number/);
 assert.equal(creditEstimate({amountText:'1',decimals:18,rate,limit:null}).capped,false);
});

// ---------------------------------------------------------------- deposits

const dep=(o)=>({id:'0xabc:0',tx_hash:'0x'+'ab'.repeat(32),block:'75836000',symbol:'ANYR',amount:'1000',raw_amount:'1000000000000000000000',status:'pending_finality',stage:'confirming',credited_usd:null,price_usd:null,note:null,price_reason:null,at:'2026-09-29T17:40:00.000Z',...o});

test('a deposit walks confirming -> awaiting_price -> crediting -> credited, and each stage says what it is waiting for',()=>{
 const c=depositView(dep({}),ESCROW_INFO);
 assert.deepEqual([c.stage,c.tone,c.step,c.label],['confirming','wait',1,'Waiting for finality']);
 assert.match(c.detail,/block 75836000/);
 assert.match(c.detail,/3,600 behind/,'the finalized block is 3,600 blocks behind');
 assert.match(c.detail,/about 7 minutes/);
 const w=depositView(dep({status:'pending',stage:'awaiting_price',note:NO_PRICE.reason.message,price_reason:{code:'price_swinging'}}),ESCROW_INFO);
 assert.deepEqual([w.stage,w.tone,w.step,w.label],['awaiting_price','warn',2,'Waiting for a price']);
 assert.equal(w.detail,NO_PRICE.reason.message);
 assert.match(depositView(dep({status:'pending',stage:'awaiting_price'}),ESCROW_INFO).detail,/no trustworthy price/,'a reason-less wait still explains itself');
 const p=depositView(dep({status:'pending',stage:'crediting'}),ESCROW_INFO);
 assert.deepEqual([p.tone,p.step,p.label],['wait',3,'Crediting']);
 const ok=depositView(dep({status:'credited',stage:'credited',credited_usd:0.082392,price_usd:8.239212e-05,at:'2026-09-29T17:52:00.000Z'}),ESCROW_INFO);
 assert.deepEqual([ok.tone,ok.step,ok.label],['ok',4,'Credited']);
 assert.equal(ok.detail,'$0.0824 added to your balance at $0.00008239 per ANYR.');
 const cap=depositView(dep({status:'credited',stage:'credited',credited_usd:250,note:'Credited $250.00 of $500.00: ANYR deposits are credited up to $250.00 each. The rest is held for operator review.'}),ESCROW_INFO);
 assert.match(cap.detail,/^\$250\.00 added to your balance\. Credited \$250\.00 of \$500\.00/);
 assert.equal(depositView(dep({status:'reversed',stage:'reversed'}),ESCROW_INFO).step,3,'a reversal undoes the last step');
 assert.deepEqual([depositView(dep({status:'reversed',stage:'reversed'}),ESCROW_INFO).tone,depositView(dep({status:'orphaned',stage:'orphaned',note:'Dropped before its block was final; nothing was credited.'}),ESCROW_INFO).label],['bad','Not credited']);
 assert.equal(depositView(dep({}),{...ESCROW_INFO,credit_block:'75836500'}).detail.includes('behind'),false,'no distance once the block is final');
 assert.doesNotThrow(()=>depositView(dep({}),null),'finality details are optional');
});

test('a router that only sends status still maps to a stage',()=>{
 assert.equal(stageOf({status:'pending_finality'}),'confirming');
 assert.equal(stageOf({status:'pending'}),'crediting');
 assert.equal(stageOf({status:'credited'}),'credited');
 assert.equal(stageOf({status:'orphaned'}),'orphaned');
 assert.equal(stageOf({status:'reversed'}),'reversed');
 assert.equal(stageOf({stage:'awaiting_price',status:'pending'}),'awaiting_price');
 assert.deepEqual(STEPS,['Sent','Final','Priced','Credited']);
});

test('tracking polls quickly only while a deposit is on its way, and spots a fresh credit once',()=>{
 assert.equal(pollInterval([]),20000);
 assert.equal(pollInterval(null),20000);
 assert.equal(pollInterval([dep({stage:'credited',status:'credited'})]),20000);
 assert.equal(pollInterval([dep({stage:'credited',status:'credited'}),dep({id:'2'})]),5000);
 assert.equal(pollInterval([dep({stage:'awaiting_price',status:'pending'})]),5000);
 const before=[dep({}),dep({id:'old',stage:'credited',status:'credited'})];
 const after=[dep({stage:'credited',status:'credited',credited_usd:1}),dep({id:'old',stage:'credited',status:'credited'})];
 assert.deepEqual(newlyCredited(before,after).map((d)=>d.id),['0xabc:0']);
 assert.deepEqual(newlyCredited(after,after),[]);
 assert.deepEqual(newlyCredited(undefined,after).length,2);
 const mixed=[dep({id:'a'}),dep({id:'b',symbol:'NVDA'}),dep({id:'c'})];
 assert.deepEqual(depositsOf(mixed,'ANYR').map((d)=>d.id),['a','c']);
 assert.deepEqual(depositsOf(mixed,'ANYR',1).map((d)=>d.id),['a']);
 assert.deepEqual(depositsOf(null,'ANYR'),[]);
});

test('the attested-lane line says what the router does, and only that',()=>{
 assert.match(ANYR_ATTESTED_LINE,/"lane": "attested"/);
 assert.match(ANYR_ATTESTED_LINE,/verified, or refuses it/);
 assert.match(ANYR_ATTESTED_LINE,/receipt records the lane/);
});

// ---------------------------------------------------------------- the component never touches keys

test('the payment dialog only asks the wallet to send one ERC-20 transfer; it never signs, stores or reads a key',()=>{
 const src=fs.readFileSync(new URL('../components/PayAnyr.jsx',import.meta.url),'utf8');
 for(const forbidden of [/privateKey/i,/mnemonic/i,/seed ?phrase/i,/personal_sign/,/eth_sign/,/signTypedData/,/localStorage/,/sessionStorage/,/eth_requestAccounts/])assert.doesNotMatch(src,forbidden,String(forbidden));
 assert.match(src,/sendTransactions\(/);
 assert.match(src,/erc20TransferData\(escrow\.address/);
 // Everything the dialog fetches is a GET on the router's escrow and credit endpoints.
 assert.deepEqual([...new Set([...src.matchAll(/api\("([^"]+)"/g)].map((m)=>m[1]))].sort(),['/api/v1/credits','/api/v1/escrow','/api/v1/escrow/anyr/price','/api/v1/escrow/deposits']);
 assert.doesNotMatch(src,/method:\s*"(POST|PUT|PATCH|DELETE)"/);
});

// ---------------------------------------------------------------- QR code

// Independent geometry and decoding, so the encoder is checked against the standard rather than against itself.
const FORMAT_M=['101010000010010','101000100100101','101111001111100','101101101001011','100010111111001','100000011001110','100111110010111','100101010100000'];
const BLOCKS_M={1:[10,[1,16]],2:[16,[1,28]],3:[26,[1,44]],4:[18,[2,32]],5:[24,[2,43]],6:[16,[4,27]],7:[18,[4,31]],8:[22,[2,38],[2,39]],9:[22,[3,36],[2,37]],10:[26,[4,43],[1,44]]};
const ALIGN={2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
function reserved(size,version){
 const r=Array.from({length:size},()=>Array(size).fill(false));
 const box=(x0,y0,x1,y1)=>{for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(x>=0&&y>=0&&x<size&&y<size)r[y][x]=true};
 box(0,0,8,8);box(size-8,0,size-1,8);box(0,size-8,8,size-1); // finder + separator + format
 box(6,0,6,size-1);box(0,6,size-1,6); // timing
 const a=ALIGN[version]??[];
 for(const cy of a)for(const cx of a){if((cx===6&&cy===6)||(cx===6&&cy===a.at(-1))||(cx===a.at(-1)&&cy===6))continue;box(cx-2,cy-2,cx+2,cy+2)}
 if(version>=7){box(size-11,0,size-9,5);box(0,size-11,5,size-9)}
 return r;
}
const EXP=[],LOG=[];for(let i=0,x=1;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d}
const gmul=(a,b)=>a&&b?EXP[(LOG[a]+LOG[b])%255]:0;
const MASKS=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];

function decode(m){
 const size=m.size,mod=m.modules;
 const fb=[];for(let i=0;i<=5;i++)fb.push(mod[i][8]);fb.push(mod[7][8],mod[8][8],mod[8][7]);for(let i=9;i<15;i++)fb.push(mod[8][14-i]);
 const format=fb.map((b)=>b?1:0).reverse().join(''); // bit 14 first
 // Bits were collected LSB first (i = 0..14), so reverse to read them as the standard prints them.
 const mask=FORMAT_M.indexOf(format);
 assert.ok(mask>=0,'the format bits are a valid level-M format word: '+format);
 const fixed=reserved(size,m.version);
 const bytes=[];let cur=0,n=0;
 for(let right=size-1;right>=1;right-=2){
  if(right===6)right=5;
  for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){
   const x=right-j,y=((right+1)&2)===0?size-1-vert:vert;
   if(fixed[y][x])continue;
   let bit=mod[y][x];if(MASKS[mask](x,y))bit=!bit;
   cur=(cur<<1)|(bit?1:0);if(++n===8){bytes.push(cur);cur=0;n=0}
  }
 }
 const [ecc,...groups]=BLOCKS_M[m.version];
 const blocks=[];for(const [count,size2] of groups)for(let i=0;i<count;i++)blocks.push({size:size2,data:[],ecc:[]});
 let at=0;
 for(let i=0;i<Math.max(...blocks.map((b)=>b.size));i++)for(const b of blocks)if(i<b.size)b.data.push(bytes[at++]);
 for(let i=0;i<ecc;i++)for(const b of blocks)b.ecc.push(bytes[at++]);
 for(const b of blocks){ // every syndrome of data+ecc is zero
  const word=[...b.data,...b.ecc];
  for(let j=0;j<ecc;j++){let acc=0;for(const c of word)acc=gmul(acc,EXP[j])^c;assert.equal(acc,0,'Reed-Solomon syndrome '+j)}
 }
 const data=blocks.flatMap((b)=>b.data);
 const bits=data.map((b)=>b.toString(2).padStart(8,'0')).join('');
 assert.equal(bits.slice(0,4),'0100','byte mode');
 const lenBits=m.version<10?8:16;
 const len=parseInt(bits.slice(4,4+lenBits),2);
 const out=[];for(let i=0;i<len;i++)out.push(parseInt(bits.slice(4+lenBits+8*i,12+lenBits+8*i),2));
 return new TextDecoder().decode(Uint8Array.from(out));
}

test('format words are the level-M words of the standard',()=>{
 for(let mask=0;mask<8;mask++)assert.equal(formatBits(mask).toString(2).padStart(15,'0'),FORMAT_M[mask],'mask '+mask);
});

test('the escrow address and the token contract encode as version 3 codes that decode back exactly',()=>{
 for(const text of [ESCROW,ANYR,'0x'+'ab'.repeat(20)]){
  const m=qrMatrix(text);
  assert.equal(m.version,3);
  assert.equal(m.size,29);
  assert.equal(decode(m),text);
 }
 assert.equal(capacity(3),42,'a 42-character address is the largest version 3 can hold at level M');
});

test('codes of every supported version decode back exactly, including multi-block and version-info layouts',()=>{
 for(let v=1;v<=MAX_VERSION;v++){
  const cut=('anyroute-'+v+'-abcdefghijklmnopqrstuvwxyz0123456789').repeat(12).slice(0,capacity(v)); // ASCII, full to the last byte
  const m=qrMatrix(cut);
  assert.equal(m.version,v,'version '+v);
  assert.equal(m.size,17+4*v);
  assert.equal(decode(m),cut);
 }
});

test('function patterns are in place and the size grows with the text',()=>{
 const m=qrMatrix(ESCROW);
 const at=(x,y)=>m.modules[y][x];
 for(const [ox,oy] of [[0,0],[22,0],[0,22]]){ // finder patterns: 7x7 ring, 3x3 core
  for(let i=0;i<7;i++)for(const [x,y] of [[ox+i,oy],[ox+i,oy+6],[ox,oy+i],[ox+6,oy+i]])assert.equal(at(x,y),true);
  assert.equal(at(ox+3,oy+3),true);
  assert.equal(at(ox+1,oy+1),false);
 }
 for(let i=8;i<21;i++){assert.equal(at(i,6),i%2===0);assert.equal(at(6,i),i%2===0)} // timing
 assert.equal(at(8,29-8),true,'the fixed dark module');
 assert.equal(qrMatrix('a').size,21);
 assert.equal(qrMatrix('x'.repeat(200)).version,10);
 assert.throws(()=>qrMatrix('x'.repeat(214)),/Too long/);
});

test('the SVG path covers exactly the dark modules',()=>{
 const m=qrMatrix(ESCROW);
 const d=qrPath(m);
 const painted=new Set();
 for(const [,x,y,w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g).map((a)=>[a[0],+a[1],+a[2],+a[3]]))for(let i=0;i<w;i++)painted.add(`${x+i},${y}`);
 const dark=new Set();
 m.modules.forEach((row,y)=>row.forEach((v,x)=>{if(v)dark.add(`${x},${y}`)}));
 assert.deepEqual([...painted].sort(),[...dark].sort());
 assert.match(d,/^(M\d+ \d+h\d+v1h-\d+z)+$/);
});

test('the codes are stable: fixed inputs give fixed modules (checked with an independent reader when these digests were recorded)',()=>{
 const digest=(t)=>crypto.createHash('sha256').update(qrMatrix(t).modules.map((r)=>r.map((b)=>b?1:0).join('')).join('\n')).digest('hex');
 assert.equal(digest(ESCROW),'e711093c2fc934b167bc89c440f5f3696269f2212510b7657ed916f22f0aeff1');
 assert.equal(digest(ANYR),'db229a5b3c721f796bef14c65adc3d40fafb3ad6e0543dc5514884e6ad211cef');
});
