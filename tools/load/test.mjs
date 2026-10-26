import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {endpoint,memoryBytes,summary,apiLoad,saveMeasurement,memoryMode,memoryMetrics} from './run.mjs';
test('percentiles, docker units and local-only guard',()=>{
  assert.deepEqual(summary([4,2,1,3]),{p50:2,p95:4,p99:4});
  assert.equal(memoryBytes('1.5MiB'),1572864);assert.throws(()=>memoryBytes('unknown'));
  assert.throws(()=>endpoint('https:/external'));assert.throws(()=>endpoint('file:/tmp/x'));
});
test('API load collects real response latency and rejects HTTP failures',async()=>{
  const server=createServer((_q,r)=>{r.writeHead(403);r.end('{}');});
  await new Promise(r=>server.listen(0,'localhost',r));
  try{const u=new URL('http:/localhost');u.port=String(server.address().port);const r=await apiLoad(u.href,'synthetic',1,10);assert(r.bad>0);assert(r.times.length>0);assert(r.times.every(Number.isFinite));}finally{await new Promise(r=>server.close(r));}
});

test('measurement writer validates and never overwrites a run', async()=>{
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'load-result-'));
  const doc={schema_version:1,tool:'other',role:'codex',test_name:'concurrent-load',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),result:'partial',metrics:{upload_count:50}};
  try{const a=saveMeasurement(doc,dir),b=saveMeasurement(doc,dir);assert.notEqual(a,b);assert(a.includes('50x50mb-api200rps'));assert.deepEqual(JSON.parse(await readFile(a,'utf8')),doc);assert.throws(()=>saveMeasurement({...doc,result:'invalid'},dir));}finally{await rm(dir,{recursive:true,force:true});}
});

test('memory skip is explicit and never fabricates zero memory',()=>{
  assert.equal(memoryMode({}),'docker');assert.equal(memoryMode({LOAD_MEMORY:'skip'}),'skip');
  assert.throws(()=>memoryMode({LOAD_MEMORY:'auto'}));
  assert.deepEqual(memoryMetrics(true,0,0,0),{docker_memory_peak_bytes:'unverified',docker_memory_samples:'unverified',docker_memory_errors:'unverified'});
  assert.equal(memoryMetrics(false,123,2,0).docker_memory_peak_bytes,123);
});
