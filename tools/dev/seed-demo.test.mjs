import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localOnly,requireDemo} from './local-only.mjs';
import {states,populateMaterials,DEMO_MATERIAL_COUNT,verifyCommerce,failureMessage,run,acknowledgeVerified,ACTIVE_ORDER_LICENSE_SQL} from './seed-demo.mjs';
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
  assert.throws(()=>verifyCommerce({...doc,notes:'لم يُقَس: refund: POST /orders/{id}/refunds is not served yet'},1));
  assert.doesNotThrow(()=>verifyCommerce({...doc,notes:'download link: fetching needs object storage; refund verification completed'},1));
  assert.throws(()=>verifyCommerce({...doc,result:'fail'},1));
  assert.throws(()=>verifyCommerce({...doc,metrics:{checks_failed:1}},1));
});

test('failure phase is safe and preflight remains nonzero',async()=>{
  assert.match(failureMessage('sandbox_purchase'),/sandbox_purchase/);
  assert.equal(failureMessage('secret-token-not-for-output').includes('secret-token'),false);
  await assert.rejects(()=>run({}),/failed at configuration/);
});

test('acknowledgement waits for verification and retries stale ETag with a fresh read',async()=>{
  let reads=0,writes=0,waits=0;const etags=[];
  const http={get:async()=>{reads++;return {status:200,body:{technical_state:reads===1?'pending':'verified',editorial_state:'inbox'},headers:{etag:String(reads)}};},call:async(_t,_m,_p,options)=>{writes++;etags.push(options.headers['if-match']);return {status:writes===1?412:200};}};
  await acknowledgeVerified(http,'synthetic','synthetic-material',{attempts:4,wait:async()=>{waits++;}});
  assert.equal(reads,3);assert.equal(writes,2);assert.equal(waits,2);assert.deepEqual(etags,['2','3']);
});
test('unverified material times out and terminal verification failure never transitions',async()=>{
  let writes=0,reads=0;const http={get:async()=>{reads++;return {status:200,body:{technical_state:'pending'}};},call:async()=>{writes++;}};
  await assert.rejects(()=>acknowledgeVerified(http,'synthetic','synthetic-material',{attempts:2,wait:async()=>{}}),/timed out/);
  assert.equal(reads,2);assert.equal(writes,0);
  http.get=async()=>({status:200,body:{technical_state:'failed'}});
  await assert.rejects(()=>acknowledgeVerified(http,'synthetic','synthetic-material'),/verification failed/);
  assert.equal(writes,0);
});
test('active license query executes on the migrated local database', {skip:!process.env.DEMO_TEST_DATABASE_URL},async()=>{
  const {default:pg}=await import('pg');
  const databaseUrl=process.env.DEMO_TEST_DATABASE_URL;
  assert.equal(process.env.DEMO_LOCAL_ONLY,'1');localOnly(databaseUrl,['postgres:','postgresql:']);
  const db=new pg.Client({connectionString:databaseUrl});
  try {
    await db.connect();await db.query('BEGIN READ ONLY');
    // PostgreSQL يحلل أسماء الأعمدة والربط حتى دون صفوف تطابق المعامل الفارغ.
    const result=await db.query(ACTIVE_ORDER_LICENSE_SQL,[null]);assert.equal(result.rowCount,0);
    const columns=await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='licenses'");
    assert(columns.rows.some(r=>r.column_name==='order_item_id'));
    assert(!columns.rows.some(r=>r.column_name==='order_id'));
  } finally {await db.query('ROLLBACK').catch(()=>{});await db.end();}
});
