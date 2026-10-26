import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localOnly,requireDemo} from './local-only.mjs';
import {states} from './seed-demo.mjs';
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
