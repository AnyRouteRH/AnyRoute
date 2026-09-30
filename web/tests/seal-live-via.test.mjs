import test from 'node:test';
import assert from 'node:assert/strict';
import {liveRows} from '../lib/seal-live.js';

const lanes=(unlinkable)=>({lanes:{public:{available:true,models:3},attested:{available:true,models:1},unlinkable}});
const row=(data)=>liveRows(data).find((r)=>r.name==='Unlinkable lane');

test('the unlinkable lane row names the transports the router reports, and only those',()=>{
 assert.equal(row(lanes({available:true,models:1,via:['onion']})).value,'Available · 1 model · via Tor onion service');
 assert.equal(row(lanes({available:true,models:2,via:['ohttp','onion']})).value,'Available · 2 models · via Oblivious HTTP relay or Tor onion service');
 assert.equal(row(lanes({available:true,models:2,via:['ohttp']})).value,'Available · 2 models · via Oblivious HTTP relay');
 // An older router without via, or a name this page does not know: nothing is guessed.
 assert.equal(row(lanes({available:true,models:2})).value,'Available · 2 models');
 assert.equal(row(lanes({available:true,models:2,via:['carrier-pigeon']})).value,'Available · 2 models');
 assert.equal(row(lanes({available:false,models:0,via:[]})).value,'Not switched on here');
});
