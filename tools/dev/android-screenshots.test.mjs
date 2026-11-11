import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {captureMetrics,measurement} from './write-android-screenshots.mjs';
import {writeResult} from '../acceptance/lib/measurement.mjs';
const names=['01-home','02-materials','03-new-material','04-uploads','05-notifications'];
function header(width,height) {
  const b=Buffer.alloc(25); b.write('89504e470d0a1a0a',0,'hex'); b.write('IHDR',12); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); return b;
}
function fixture(root) {
  for(const locale of ['ar','en-US']) for(const [category,w,h]of [['phone',1080,1920],['sevenInch',1200,1920],['tenInch',1600,2560]]) {
    const dir=join(root,'apps/android/store/captures',locale,category); mkdirSync(dir,{recursive:true});
    // Headers generated at runtime exercise dimensions only, not visual PNG decoding.
    for(const name of names) writeFileSync(join(dir,name+'.png'),header(w,h));
  }
}
function temporary(fn) {const root=mkdtempSync(join(tmpdir(),'store-capture-test-')); try{fn(root);}finally{rmSync(root,{recursive:true,force:true});}}
test('matrix count is derived; measurement stays partial pending visual review',()=>temporary(root=>{
  fixture(root); const metrics=captureMetrics(root); assert.equal(metrics.screenshots,30); assert.equal(metrics.visual_owner_review,'unverified');
  const doc=measurement('2026-10-26T00:00:00Z',metrics); assert.equal(doc.result,'partial'); assert.equal(writeResult(doc,{dryRun:true}),null);
}));
test('missing capture rejects the matrix',()=>temporary(root=>{
  fixture(root); unlinkSync(join(root,'apps/android/store/captures/en-US/tenInch/05-notifications.png'));
  assert.throws(()=>captureMetrics(root),/incomplete capture set/);
}));
test('wrong device dimensions rejected by both validators',()=>temporary(root=>{
  fixture(root); const dir=join(root,'apps/android/store/captures/ar/phone');
  assert.equal(spawnSync('python3',['tools/dev/check-android-screenshots.py',dir,'1080x1920']).status,0);
  writeFileSync(join(dir,'01-home.png'),header(720,1280)); assert.throws(()=>captureMetrics(root),/invalid capture dimensions/);
  assert.notEqual(spawnSync('python3',['tools/dev/check-android-screenshots.py',dir,'1080x1920']).status,0);
}));
test('capture requires explicit disposable-data consent before invoking devices',()=>{
  const env={...process.env};delete env.DEMO_CAPTURE_ONLY;
  const r=spawnSync('bash',['tools/dev/android-screenshots.sh'],{env,encoding:'utf8'});
  assert.equal(r.status,2);assert.match(r.stderr,/DEMO_CAPTURE_ONLY=1 required/);
});
test('capture refuses incomplete configuration without printing credential values',()=>{
  const env={...process.env,DEMO_CAPTURE_ONLY:'1',DEMO_CAPTURE_PASSWORD:'test-only-sentinel'};delete env.SCREENSHOT_PHONE_AVD;
  const r=spawnSync('bash',['tools/dev/android-screenshots.sh'],{env,encoding:'utf8'});
  assert.equal(r.status,2);assert.match(r.stderr,/Required setting missing/);assert.ok(!r.stderr.includes('test-only-sentinel'));
});
