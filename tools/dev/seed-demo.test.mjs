import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localOnly,requireDemo} from './local-only.mjs';
import {states,populateMaterials,DEMO_MATERIAL_COUNT,verifyCommerce,failureMessage,run} from './seed-demo.mjs';
test('refuse external services and require explicit disposable database consent',()=>{
  assert.throws(()=>requireDemo({}));
  assert.throws(()=>localOnly('https:'+String.fromCharCode(47,47)+'external',['http:']));
  assert.throws(()=>localOnly('file:/tmp/db',['postgres:']));
});
test('forty synthetic rows keep three independent tracks',()=>{
  const rows=Array.from({length:40},(_,i)=>states(i));
  assert.equal(new Set(rows.map(r=>r.technical)).size,5);
  assert.equal(new Set(rows.map(r=>r.editorial)).size,9);
  assert.equal(new Set(rows.map(r=>r.rights)).size,5);
});

test('population creates exactly forty distinct demo material identifiers',async()=>{
  const seen=[];
  const ids=await populateMaterials(async i=>{seen.push(i);return `synthetic-${i}`;});
  assert.equal(DEMO_MATERIAL_COUNT,40);
  assert.equal(seen.length,40);assert.equal(new Set(ids).size,40);
  assert.equal(seen.at(-1),39);
});

test('deferred link inspection is allowed but an actual refund is required',()=>{
  const doc={result:'partial',metrics:{checks_failed:0,deferred_checks:1}};
  assert.doesNotThrow(()=>verifyCommerce(doc,1));
  assert.throws(()=>verifyCommerce(doc,0));
  assert.throws(()=>verifyCommerce({...doc,result:'fail'},1));
  assert.throws(()=>verifyCommerce({...doc,metrics:{checks_failed:1}},1));
});

test('failure phase is safe and preflight remains nonzero',async()=>{
  assert.match(failureMessage('sandbox_purchase'),/sandbox_purchase/);
  assert.equal(failureMessage('secret-token-not-for-output').includes('secret-token'),false);
  await assert.rejects(()=>run({}),/failed at configuration/);
});
