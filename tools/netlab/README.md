# netlab

محاكي شبكة متقطعة وأداة قياس. يملكه وكيل الرفع والبنية. القرار: ADR 0007 (toxiproxy).

## المكوّنات

| الملف | الغرض |
| --- | --- |
| `scenarios/*.yaml` | السيناريوهات الثلاثة (`office`، `field-weak`، `field-switch`) |
| `compose.netlab.yml` | طبقة فوق compose الأساسي: toxiproxy أمام `tusd-proxy`، وحاوية `netlab-loss` لفقد الحزم (netem أو iptables)، وبديل خطّاف `api` على شبكة `hooks` |
| `hook_stub.py` | بديل نقطة الخطّاف (SEC-06) إلى أن يوجد الخادم: يقارن الرمز ويقبل كل رفع، ويثبّت معرّف tus على `upload_session_id` كالخادم |
| `netlab.py` | عميل tus يرفع عبر السيناريو ويكتب النتيجة بمخطط `contracts/schemas/measurement.json` |
| `blocking.py` + `compose.blocking.yml` + `blocking/` | محاكاة حجب DNS/IP/SNI للنطاق الرئيسي ولنطاق ingest (ADR 0011): أي نقطة رفع تبقى تعمل تحت أي حجب. `python3 tools/netlab/blocking.py --out docs/measurements/netlab/$(date +%F)-ingest-blocking.json` (يشغّل compose وحده وينزله) |

## التشغيل

```bash
cd infra/compose && cp .env.example .env
sed -i "s/^TUSD_HOOK_SECRET=.*/TUSD_HOOK_SECRET=$(openssl rand -hex 32)/" .env
docker compose -f docker-compose.yml -f ../../tools/netlab/compose.netlab.yml up -d --wait
cd ../..
python3 tools/netlab/netlab.py run --scenario office --size-mb 500 \
  --out docs/measurements/netlab/$(date +%F)-tusd-office-500mb.json
```

**عميل خارجي (`--client-cmd`):** يُقاس عميل رفع آخر بالتعريفات نفسها: أمر صدفة بعناصر `{endpoint}` `{host}` `{file}` `{size}` `{chunk}` `{timeout}` `{max_seconds}` يطبع في آخر سطر من stdout ملخص الجلسة JSON (`url_path`، `offset`، `complete`، `parts` كمصفوفة `[seconds, bytes, ok]`، `windows`، `resumes`، `failures`، `bytes_lost`؛ انظر `run_external`)، وتبقى المقاييس والكفاءة والبصمة من هنا. `--client-label` يصف العميل في `device.model`، و`--role` من أجرى القياس. العميل الأول: نواة الرفع في iOS على Linux (`apps/ios/Packages/PostHistoryKit`، الهدف `upload-netlab`، عبر `.github/scripts/netlab-swift-client.sh`؛ وظيفة `netlab-ios-core` في سير العمل).

الخيارات: `--chunk-mb` (حجم طلب PATCH؛ الافتراضي `client_chunk_mb` في السيناريو)، `--timeout-s` (مهلة خمول المقبس، 60)، `--event-scale` (لتجربة سريعة فقط؛ القياس المرجعي بـ 1)، `--max-seconds` (حد زمني؛ إن انتهى قبل الاكتمال فالنتيجة `partial`)، `--file` (ملف اصطناعي موجود). الملف الاصطناعي يُولَّد عشوائيًا في `--workdir` ولا يُرفع إلى المستودع.

## ما يُقاس (`metrics`)

- `longest_connected_window_s`: أطول مدة من أول طلب ناجح إلى الفشل التالي، كما يراها العميل.
- `part_time_s_p50/p90/max` و`part_times_s`: زمن كل PATCH ناجح؛ `parts_failed` للمحاولات المقطوعة (tusd يحفظ ما وصل منها).
- `resumes`: مرات الاستئناف عبر `HEAD` بعد فشل؛ `connection_failures`.
- `checksum_match`: SHA-256 للأصل مقابل الكائن في MinIO (عبر `mc` في حاوية على شبكة compose؛ tusd يعمل بـ `-disable-download`).

## معيار `field-network-upload` على مرحلتين (قرار المنسّق، 2026-10-19)

1. **(أ) netlab في CI:** ملف 100 MB على `field-weak` بفقد netem (سير عمل `netlab` يدويًا بالقيم الافتراضية). المقياسان:
   - `efficiency_vs_mathis` ≥ 0.70: الإنتاجية خلال وقت الاتصال (`goodput_connected_kbps`، بلا فترات الثقب الأسود) مقسومة على min(حد Mathis، سعة الرابط). حد Mathis = 1.22 × MSS ÷ (RTT × √p)، وهو نحو 86 kbit/s عند RTT 300 ms وفقد 30%.
   - `bytes_lost_on_resume` = 0: كل استئناف يبدأ من آخر إزاحة أكّدها الخادم أو بعدها.

   النتيجة `partial` إن تحقق الاثنان (`stage_a_ok: true`)، و`fail` إن لم يتحققا. الأداة لا تكتب `pass` أبدًا.
2. **(ب) القياس اليدوي:** 1 GB على جهاز وشبكة فعليين في الأسبوع الخامس، وهو وحده الذي يعطي `pass`.

## حدود معروفة

- الفقد: `metrics.loss_mode` يقول كيف طُبِّق. `netem` مرجعي، و`iptables-statistic` (مضيف بلا `sch_netem`) يقلل أثر الفقد على TCP. تشغيل بفقد يُجرى وحده لأن الإعداد يخص الوسيط كله.
- القياس المرجعي على مشغّل GitHub: سير عمل `netlab` يدويًا (`workflow_dispatch`)، والنتيجة artifact تُرفع إلى `docs/measurements/netlab/`.
- القياس من عميل اصطناعي على الخادم نفسه، لا من هاتف.
- toxiproxy يقرأ من العميل قبل أن يسلّم (مخزن داخلي)، فما «أرسله» العميل ليس ما وصل؛ الإزاحة الحقيقية من `HEAD` فقط. لذلك يجب أن تتجاوز مهلة العميل زمن الجزء على أبطأ ملف (1 MiB على 0.5 ميغابت/ث ≈ 17 ث).
- إزالة سم `bandwidth` من وسيط فيه نقل جارٍ قد تعلق واجهة toxiproxy؛ التبديل يعيد إنشاء الوسيط بدل تعديل سمومه.

## هاتف فعلي

منافذ compose مربوطة بـ `127.0.0.1`. لاختبار الرفع من هاتف على الشبكة المحلية استخدم `docker-compose.override.yml` (غير مرفوع) يفتح منفذ `tusd-proxy` (أو منفذ سيناريو في toxiproxy) وحده على واجهة الشبكة، ولا تعدّل الملف الأساسي إلى `0.0.0.0`. tusd نفسه بلا منفذ منشور.
