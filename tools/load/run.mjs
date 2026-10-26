#!/usr/bin/env node
// اختبار القبول رقم 4: «التحمل تحت الحمل المتزامن» (concurrent-load، صف الحمل المتزامن في الخطة).
// ملف 50 MB وخمسون رفعًا هنا نطاق #352؛ لا يثبت معيار الخطة 60 × 2 GB.
import autocannon from 'autocannon';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {writeResult} from '../acceptance/lib/measurement.mjs';
import {isIP} from 'node:net';
import {client,materialBody,createUploadSession} from '../acceptance/lib/live.mjs';
import {makeSyntheticFile,resumableUpload} from '../acceptance/lib/tus.mjs';
import {tusAuth} from '../acceptance/lib/ingest.mjs';
const exec=promisify(execFile);
export function endpoint(value) {
  const u=new URL(value),h=u.hostname;
  if(u.protocol!=='http:' || !(h==='localhost'||['api','tusd'].includes(h)||isIP(h)===4&&Number(h.split('.')[0])===127)||u.search||u.hash||u.username||u.password) throw new Error('local compose URL required');
  return value.replace(/\/$/,'');
}
export function summary(values) {
  const v=[...values].sort((a,b)=>a-b);
  const p=n=>v.length?v[Math.max(0,Math.ceil(v.length*n/100)-1)]:null;
  return {p50:p(50),p95:p(95),p99:p(99)};
}
export function memoryBytes(value) {
  const m=/^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/.exec(value.trim());
  if(!m) throw new Error('unsupported docker memory unit');
  const units={B:1,KiB:1024,MiB:1024**2,GiB:1024**3,kB:1000,MB:1000**2,GB:1000**3};
  return Number(m[1])*units[m[2]];
}
export async function apiLoad(url,token,duration,rate=100) {
  const times=[];let bad=0;
  const result=await new Promise((resolve,reject)=>{
    const load=autocannon({url,connections:50,overallRate:rate,duration,headers:{authorization:`Bearer ${token}`},timeout:15},(e,r)=>e?reject(e):resolve(r));
    load.on('response',(_client,status,_bytes,time)=>{times.push(time);if(status<200||status>=300)bad++;});
  });
  return {times,bad,errors:result.errors,timeouts:result.timeouts,requests:result.requests.total,rate:result.requests.average};
}
export function saveMeasurement(doc, dir=resolve('docs/measurements/api')) {
  return writeResult(doc,{dir,slug:'50x50mb-api200rps'});
}
export async function run(env=process.env) {
  if(env.LOAD_LOCAL_ONLY!=='1') throw new Error('LOAD_LOCAL_ONLY=1 required');
  const api=endpoint(env.LOAD_API_URL),tus=endpoint(env.LOAD_TUS_URL);
  const tokens=JSON.parse(env.LOAD_TOKENS??'{}');
  if(!tokens.reporter||!tokens.producer||!tokens.buyer_admin) throw new Error('synthetic role tokens required');
  const duration=Number(env.LOAD_DURATION_S??60);
  if(!Number.isInteger(duration)||duration<10||duration>600)throw new Error('duration must be 10..600 seconds');
  const containers=(env.LOAD_CONTAINERS??'').split(',').filter(Boolean);
  if(!containers.length||containers.some(c=>!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c))) throw new Error('explicit compose container names required');
  await exec('docker',['stats','--no-stream','--format','{{.MemUsage}}',...containers]);
  const started=new Date().toISOString(),metrics={upload_count:50,file_size_bytes:50_000_000,api_target_rps:200,duration_s:duration};
  let synth=null,stop=false,memoryPeak=0,memorySamples=0,memoryErrors=0,failed=false,phase='preparing_uploads';
  const monitor=(async()=>{while(!stop){try{const r=await exec('docker',['stats','--no-stream','--format','{{.MemUsage}}',...containers]);let sum=0;for(const line of r.stdout.trim().split('\n'))sum+=memoryBytes(line.split('/')[0]);memoryPeak=Math.max(memoryPeak,sum);memorySamples++;}catch{memoryErrors++;}if(!stop)await new Promise(r=>setTimeout(r,1000));}})();
  try {
    const http=client(api),form=await http.get(tokens.reporter,'/forms/current');
    if(form.status!==200)throw new Error('form read failed');
    synth=await makeSyntheticFile(50_000_000);
    const prepared=[];
    for(let i=0;i<50;i++) {
      const mat=await http.call(tokens.reporter,'POST','/materials',{body:materialBody(form.body.version,`synthetic load ${i+1}`,{city:'اصطناعية'})});
      if(mat.status!==201)throw new Error('synthetic material creation failed');
      prepared.push(await createUploadSession(http,tokens.reporter,{materialId:mat.body.id,size:50_000_000,clientSha256:synth.sha256}));
    }
    phase='uploads';
    const uploaded=await Promise.allSettled(prepared.map(async(session,i)=>{
      const r=await resumableUpload({endpoint:tus,file:synth.path,size:50_000_000,chunkSize:1024*1024,interruptAt:i%4===0?[12_500_000]:[],metadata:{upload_session_id:session.id},headers:()=>tusAuth(session,env)});
      r.agentClose(); if(r.violations.length||i%4===0&&r.interruptions!==1)throw new Error('resume invariant failed');return r;
    }));
    const good=uploaded.filter(r=>r.status==='fulfilled').map(r=>r.value);
    metrics.upload_errors=50-good.length;metrics.upload_resumed=good.filter(r=>r.interruptions===1).length;
    for(const[k,v]of Object.entries(summary(good.map(r=>r.durationMs))))if(v!==null)metrics[`upload_ms_${k}`]=v;
    // سيناريو مستقل عن الرفع؛ مجموع معدلي المسارين 200 طلب/ث.
    phase='api';
    const results=await Promise.all([apiLoad(api+'/materials?limit=20',tokens.producer,duration),apiLoad(api+'/catalog?limit=20',tokens.buyer_admin,duration)]);
    for(let i=0;i<2;i++) {
      const r=results[i],prefix=i?'catalog':'inbox';
      for(const[k,v]of Object.entries(summary(r.times)))if(v!==null)metrics[`${prefix}_ms_${k}`]=v;
      metrics[`${prefix}_errors`]=r.errors+r.timeouts+r.bad;metrics[`${prefix}_requests`]=r.requests;metrics[`${prefix}_observed_rps`]=r.rate;
      if(r.errors||r.timeouts||r.bad||r.requests<duration*100*0.95)failed=true;
    }
    if(metrics.upload_errors||metrics.upload_resumed!==13)failed=true;
  } catch {failed=true;metrics.aborted=true;metrics.failed_phase=phase;}
  finally {stop=true;await monitor;synth?.cleanup();}
  Object.assign(metrics,{docker_memory_peak_bytes:memoryPeak,docker_memory_samples:memorySamples,docker_memory_errors:memoryErrors});
  if(!memorySamples||memoryErrors)failed=true;
  const doc={schema_version:1,tool:'other',role:'codex',test_name:'concurrent-load',started_at:started,ended_at:new Date().toISOString(),result:failed?'fail':'partial',device:{platform:'server',model:'local compose: 50 uploads x 50 MB, 200 target requests/s'},upload_path:'tusd',file:{size_bytes:50_000_000},metrics,notes:metrics.aborted?`توقف الاختبار أثناء ${phase}؛ لم يكتمل السيناريو المطلوب. المقاييس الموجودة تخص ما نُفّذ فقط؛ لا تُعد الحمولة المستهدفة نتيجة ناجحة.`:'نطاق #352: 50 رفعًا مع قطع واستئناف 13 منها، ثم 200 طلب/ث مستهدف على مساري الوارد والكتالوج. الذاكرة مجموع استخدام الحاويات المحددة، لا ذاكرة المضيف. لا قياس زمن الإشعار أو القرص المؤقت ولا حجم الخطة 60 × 2 GB؛ لذلك النتيجة جزئية حتى دون أخطاء. لا إثبات بصمة الملف بعد معالجة الخادم في هذا الاختبار.'};
  saveMeasurement(doc);
  return {code:failed?1:0,doc};
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname)run().then(r=>{process.exitCode=r.code;}).catch(()=>{console.error('Load configuration or services unavailable; no measurement written.');process.exitCode=2;});
