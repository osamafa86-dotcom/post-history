import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {endpoint,memoryBytes,summary,apiLoad,saveMeasurement,memoryMode,memoryMetrics,resolveMemoryMode,loadConfig,loadScope} from './run.mjs';
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
  const doc={schema_version:1,tool:'other',role:'codex',test_name:'concurrent-load',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),result:'partial',file:{size_bytes:50_000_000},metrics:{upload_target_count:50,api_target_rps:200}};
  try{const a=saveMeasurement(doc,dir),b=saveMeasurement(doc,dir);assert.notEqual(a,b);assert(a.includes('50x50mb-api200rps'));assert.deepEqual(JSON.parse(await readFile(a,'utf8')),doc);assert.throws(()=>saveMeasurement({...doc,result:'invalid'},dir));}finally{await rm(dir,{recursive:true,force:true});}
});

test('memory fallback never fabricates zero memory',()=>{
  assert.equal(memoryMode({}),'skip');assert.equal(memoryMode({},true),'docker');assert.equal(memoryMode({LOAD_MEMORY:'skip'}),'skip');
  assert.throws(()=>memoryMode({LOAD_MEMORY:'auto'}));
  assert.deepEqual(memoryMetrics(true,0,0,0),{docker_memory_peak_bytes:'unverified',docker_memory_samples:'unverified',docker_memory_errors:'unverified'});
  assert.equal(memoryMetrics(false,123,2,0).docker_memory_peak_bytes,123);
});


test('default memory probes stats, skips unavailable stats, and respects strict opt-in',async()=>{
  let calls=0;
  const available=async()=>{calls++;};
  const unavailable=async()=>{calls++;throw new Error('unavailable');};
  assert.equal(await resolveMemoryMode({},available),'docker');
  assert.equal(await resolveMemoryMode({},unavailable),'skip');
  const before=calls;
  assert.equal(await resolveMemoryMode({LOAD_MEMORY:'skip'},unavailable),'skip');
  assert.equal(calls,before);
  await assert.rejects(()=>resolveMemoryMode({LOAD_MEMORY:'docker'},unavailable),/unavailable/);
  await assert.rejects(()=>resolveMemoryMode({LOAD_MEMORY:'invalid'},available),/LOAD_MEMORY/);
});
test('reduced load has accurate scope, bytes and interruption count',async()=>{
  const config=loadConfig({LOAD_UPLOAD_COUNT:'5',LOAD_FILE_MB:'100',LOAD_API_RPS:'20'});
  assert.deepEqual(config,{count:5,size:100_000_000,rate:20,resumed:2});
  assert.equal(loadScope(config),'5x100mb-api20rps');
  assert.deepEqual(loadConfig({}),{count:50,size:50_000_000,rate:200,resumed:13});
  for(const env of [{LOAD_UPLOAD_COUNT:'0'},{LOAD_UPLOAD_COUNT:'51'},{LOAD_FILE_MB:'101'},{LOAD_FILE_MB:'1.5'},{LOAD_API_RPS:'3'},{LOAD_API_RPS:'202'}])assert.throws(()=>loadConfig(env));
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'reduced-load-result-'));
  const doc={schema_version:1,tool:'other',role:'codex',test_name:'concurrent-load',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),result:'partial',file:{size_bytes:config.size},metrics:{upload_target_count:config.count,api_target_rps:config.rate,...memoryMetrics(true)}};
  try{const file=saveMeasurement(doc,dir);assert(file.includes('5x100mb-api20rps'));assert.deepEqual(JSON.parse(await readFile(file,'utf8')),doc);assert.throws(()=>saveMeasurement({...doc,result:'pass'},dir),/unverified/);}
  finally{await rm(dir,{recursive:true,force:true});}
});
