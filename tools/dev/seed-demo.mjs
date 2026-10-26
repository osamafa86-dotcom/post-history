#!/usr/bin/env node
// بذرة غرفة أخبار اصطناعية؛ لا تشغيل على مضيف حقيقي ولا حفظ كلمات المرور.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { seed } from '../acceptance/live/seed.mjs';
import { client, materialBody, createUploadSession } from '../acceptance/lib/live.mjs';
import { resumableUpload } from '../acceptance/lib/tus.mjs';
import { tusAuth } from '../acceptance/lib/ingest.mjs';
import { requireDemo, localOnly } from './local-only.mjs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from '../acceptance/node_modules/pg/lib/index.js';
import { hash } from '../acceptance/node_modules/@node-rs/argon2/index.js';
const exec = promisify(execFile);
export const states = i => ({technical:['pending','proxy_received','original_received','verified','failed'][i%5], editorial:['inbox','acknowledged','reviewing','needs_changes','accepted','in_production','final_review','published','rejected'][i%9], rights:['unknown','documented','sellable','blocked','withdrawn'][i%5]});
export async function run(env=process.env) {
  requireDemo(env);
  localOnly(env.TUS_URL,['http:']);
  if (!env.SP_WEBHOOK_SECRET) throw new Error('sandbox webhook configuration required');
  await exec('ffmpeg',['-version']);
  const dir=await mkdtemp(join(tmpdir(),'newsroom-demo-'));
  const db=new pg.Client({connectionString:env.DATABASE_URL});
  await db.connect();
  try {
    // نفس المصدر الذي يستعمله rehearsal-accounts؛ لا نكرر منطق الحسابات والأدوار.
    const s=await seed({databaseUrl:env.DATABASE_URL,apiUrl:env.API_URL});
    const officeIds=(await db.query('SELECT DISTINCT office_id FROM users WHERE id = ANY($1::uuid[]) AND office_id IS NOT NULL',[Object.values(s.users).map(u=>u.id)])).rows.map(r=>r.office_id);
    for(let i=0;i<officeIds.length;i++) await db.query('UPDATE offices SET name_ar=$1,name_en=$2 WHERE id=$3',[`مكتب اصطناعي ${i+1}`,`Synthetic office ${i+1}`,officeIds[i]]);
    const credentials=Object.entries(s.users).map(([role,u])=>({role,email:u.email,password:s.password}));
    const reporters=[s.users.reporter,s.users.reporter_b,s.users.victim_reporter];
    for(let i=0;i<3;i++) {
      const password=randomBytes(18).toString('base64url');
      const email=`demo-${randomUUID()}@${s.users.reporter.email.split('@')[1]}`;
      const role='reporter';
      const u=(await db.query("INSERT INTO users(email,password_hash,status,office_id) VALUES($1,$2,'active',$3) RETURNING id",[email,await hash(password),officeIds[i%officeIds.length]])).rows[0];
      await db.query("INSERT INTO user_roles(user_id,role,scope_kind,scope_id) VALUES($1,$2,'all','')",[u.id,role]);
      if(i<3) reporters.push({...u,email});
      credentials.push({role,email,password});
    }
    // إزالة قيَم الاختبار الكاشفة من مواد seed نفسها قبل استعمالها في العروض.
    await db.query("UPDATE materials SET gps_enc=NULL,title='مادة اصطناعية تمهيدية',city='مدينة اصطناعية' WHERE id=ANY($1::uuid[])",[[s.uploads.materialA,s.uploads.materialB]]);
    const http=client(env.API_URL);
    const file=join(dir,'synthetic.mp4');
    await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','mpeg4','-c:a','aac','-y',file]);
    const digest=createHash('sha256'); for await(const block of createReadStream(file)) digest.update(block);
    const sha=digest.digest('hex'),size=(await stat(file)).size;
    for(let i=0;i<30;i++) {
      const m=await http.call(s.tokens.reporter,'POST','/materials',{body:materialBody(s.formVersion,`مادة اصطناعية ${i+1}`,{city:`مدينة اصطناعية ${i%2+1}`})});
      if(m.status!==201) throw new Error('demo material creation failed');
      // الرفع الحقيقي أولًا، ثم توزيع حالات العرض دون ادعاء مرور خط المعالجة.
      const session=await createUploadSession(http,s.tokens.reporter,{materialId:m.body.id,size,clientSha256:sha,filename:'synthetic.mp4'});
      const result=await resumableUpload({endpoint:env.TUS_URL,file,size,chunkSize:1024*1024,interruptAt:[],metadata:{upload_session_id:session.id},headers:()=>tusAuth(session,env)});
      result.agentClose(); if(result.violations.length) throw new Error('demo upload violated resume invariants');
      const st=states(i),r=reporters[i%6];
      await db.query('UPDATE materials SET reporter_id=$1,office_id=$2,technical_state=$3,editorial_state=$4,rights_state=$5 WHERE id=$6',[r.id,officeIds[i%2],st.technical,st.editorial,st.rights,m.body.id]);
    }
    // الأداة المشتركة تمر عبر المزوّد التجريبي وتتحقق من القيد والترخيص والاسترداد المتاح؛ لا نكررها.
    await exec(process.execPath, [resolve('tools/acceptance/live/sandbox-purchase.mjs')], {env:{...env,SP_API_URL:env.API_URL,SP_ROOT_URL:localOnly(env.ROOT_URL,['http:']),SP_DATABASE_URL:env.DATABASE_URL,SP_TOKENS:JSON.stringify(s.tokens),ACCEPTANCE_RESULTS_DIR:dir},maxBuffer:1024*1024});
    const {readdir,readFile}=await import('node:fs/promises');
    const reports=await readdir(dir);
    const report=reports.find(p=>p.endsWith('.json'));
    const commerce=report?JSON.parse(await readFile(join(dir,report),'utf8')):null;
    if(!commerce || commerce.result==='fail' || commerce.metrics?.checks_failed || commerce.metrics?.deferred_checks) throw new Error('sandbox verification incomplete');
    const refunded=(await db.query("SELECT count(*)::int AS n FROM orders WHERE organization_id=(SELECT organization_id FROM users WHERE id=$1) AND status='refunded'",[s.users.buyer_admin.id])).rows[0].n;
    if(!refunded) throw new Error('sandbox refund endpoint is required');
    // بيعة ثانية تبقى مدفوعة للعرض؛ الأولى تعرض الاسترداد والترخيص المبطل.
    const offer=(await db.query("SELECT o.listing_id,o.license_template_id FROM listing_offers o JOIN catalog_listings l ON l.id=o.listing_id JOIN materials m ON m.id=l.material_id JOIN license_templates t ON t.id=o.license_template_id WHERE m.reporter_id=$1 AND l.state='listed' AND t.type='editorial_single' LIMIT 1",[s.users.reporter.id])).rows[0];
    if(!offer)throw new Error('synthetic listing unavailable');
    const paid=await http.call(s.tokens.buyer_admin,'POST','/orders',{body:{items:[offer]}});
    if(paid.status!==201)throw new Error('demo paid order creation failed');
    const checkout=await http.call(s.tokens.buyer_admin,'POST',`/orders/${paid.body.id}/checkout`,{body:{}});
    if(checkout.status!==200||checkout.body.provider!=='sandbox')throw new Error('sandbox provider required');
    const checkoutUrl=new URL(localOnly(checkout.body.checkout_url,['http:']));
    const root=localOnly(env.ROOT_URL,['http:']);
    if(checkoutUrl.origin!==new URL(root).origin)throw new Error('checkout origin mismatch');
    const settle=await fetch(root+checkoutUrl.pathname+'/succeeded',{method:'POST',headers:{'idempotency-key':randomUUID()},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!settle.ok)throw new Error('sandbox settlement failed');
    let licensed=false;
    for(let i=0;i<40&&!licensed;i++){
      licensed=(await db.query("SELECT 1 FROM licenses WHERE order_id=$1 AND status='active'",[paid.body.id])).rowCount>0;
      if(!licensed)await new Promise(r=>setTimeout(r,250));
    }
    if(!licensed||(await http.get(s.tokens.buyer_admin,`/orders/${paid.body.id}`)).body.status!=='paid')throw new Error('paid license not issued');
    // قناة واحدة، مرة واحدة فقط، لا ملف حسابات أو رموز جلسة.
    process.stdout.write(JSON.stringify({synthetic:true,accounts:credentials,materials:40,commerce:commerce.result})+'\n');
  } finally { await db.end(); await rm(dir,{recursive:true,force:true}); }
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) run().catch(()=>{console.error('Demo seed failed; inspect local services without logging credentials.');process.exitCode=1;});
