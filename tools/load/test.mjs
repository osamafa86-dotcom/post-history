import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {endpoint,memoryBytes,summary,apiLoad} from './run.mjs';
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
