// يسجل الملفات المتحققة فقط؛ اعتماد الصور بصريًا عند مالك أندرويد.
import {writeResult,ROOT} from '../acceptance/lib/measurement.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function captureMetrics(root) {
  const names=['01-home','02-materials','03-new-material','04-uploads','05-notifications'].map(n=>n+'.png');
  let count=0;
  for(const locale of ['ar','en-US'])for(const [category,width,height]of [['phone',1080,1920],['sevenInch',1200,1920],['tenInch',1600,2560]]) {
    const dir=join(root,'apps/android/store/captures',locale,category);
    const files=readdirSync(dir).filter(n=>n.endsWith('.png')).sort();
    if(JSON.stringify(files)!==JSON.stringify([...names].sort()))throw new Error('incomplete capture set');
    for(const name of names){const b=readFileSync(join(dir,name));if(b.length<=24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||b.toString('ascii',12,16)!=='IHDR'||b.readUInt32BE(16)!==width||b.readUInt32BE(20)!==height)throw new Error('invalid capture dimensions');count++;}
  }
  return {screenshots:count,locales:2,form_factors:3,visual_owner_review:'unverified'};
}
export function measurement(started,metrics) {
  return {schema_version:1,tool:'android-app',role:'codex',test_name:'android-store-screenshots',started_at:started,ended_at:new Date().toISOString(),result:'partial',device:{platform:'android',model:'disposable emulator matrix'},upload_path:'n/a',metrics,notes:'لقطات على بذرة اصطناعية وخادم محلي؛ الهاتف 1080×1920، و7 بوصات 1200×1920، و10 بوصات 1600×2560. لا قياس جهاز فعلي أو اعتماد صور المتجر؛ مراجعة المالك البصرية باقية.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const started=process.argv[2];
  if(!started||!Number.isFinite(Date.parse(started)))throw new Error('capture start required');
  const metrics=captureMetrics(ROOT);
  writeResult(measurement(started,metrics),{dir:join(ROOT,'docs/measurements/android-app'),slug:'store-capture'});
}
