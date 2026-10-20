# قياس نواة الرفع (أندرويد) عبر netlab

`measure.py` يشغّل `UploadEngine` الحقيقي من `apps/android/core` على JVM (عبر `apps/android/netlab-runner`)
ضد حزمة `tools/netlab` (toxiproxy + netem) بالسيناريوهات الثلاثة، ويكتب النتيجة بمخطط
`contracts/schemas/measurement.json` في `docs/measurements/netlab/` باسم
`<التاريخ>-android-upload-core-<السيناريو>-100mb.json`. أدوات netlab تُستورد كما هي ولا تُنسخ.

- المعيار المرحلي (أ) لـ `field-network-upload`: `efficiency_vs_mathis ≥ 0.70` و`bytes_lost_on_resume = 0`
  وبصمة الخادم مطابقة؛ النتيجة `partial` في أحسن الأحوال (المرحلة (ب) على جهاز حقيقي وحدها تعطي `pass`).
- المقاييس بتعريفات `tools/netlab/netlab.py` نفسها: الـ runner يطبع في آخر سطر ملخص الجلسة بعقد العميل الخارجي
  (`--client-cmd` في #65: `parts` = [زمن طلب PATCH، بايتاته، نجح؟]، `windows`، `resumes`، `failures`، `bytes_lost`،
  `offset`، `url_path`، `complete`)، و`measure.py` يقرأه ولا يحسب حسابًا موازيًا؛ حين يُدمج العقد في `netlab.py`
  يُستبدل هذا السكربت باستدعاء `netlab.py run --client-cmd "<runner> --file {file} --tus {endpoint} --part-bytes {chunk} --max-seconds {max_seconds} --timeout {timeout}" --role android`.
- سير العمل `netlab-android` (`.github/workflows/netlab-android.yml`): على طلبات السحب التي تمس `apps/android/core`
  أو الـ runner أو هذا المجلد أو `netlab.py` سيناريو قصير واحد (office، 100 MB، 240 ث) للتحقق من أن المشغّل يعمل ويكتب
  نتيجة صالحة؛ القياس الكامل (سيناريو أو الثلاثة، الحجم والحد الزمني مدخلات) بـ `workflow_dispatch` وحده، والنتيجة
  artifact يُلتزم بها في `docs/measurements/netlab/`.
- حجم طلب PATCH يتكيّف مع السرعة المرصودة (`RequestSizer`؛ ADR 0010)، فعدد الطلبات على الرابط الضعيف أكبر من عميل بحجم ثابت.
- محليًا يحتاج docker (compose + netlab)؛ `--tus-url` يتجاوز netlab لتجربة الـ runner فقط (النتيجة `info` ولا تُلتزم).

```bash
cd apps/android && ./gradlew :netlab-runner:installDist && cd ../..
python3 apps/android/netlab/measure.py --scenario field-weak --size-mb 100 --max-seconds 2100 \
  --out docs/measurements/netlab/$(date -u +%F)-android-upload-core-field-weak-100mb.json
```
