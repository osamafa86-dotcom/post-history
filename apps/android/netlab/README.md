# قياس نواة الرفع (أندرويد) عبر netlab

`measure.py` يشغّل `UploadEngine` الحقيقي من `apps/android/core` على JVM (عبر `apps/android/netlab-runner`)
ضد حزمة `tools/netlab` (toxiproxy + netem) بالسيناريوهات الثلاثة، ويكتب النتيجة بمخطط
`contracts/schemas/measurement.json` في `docs/measurements/netlab/` باسم
`<التاريخ>-android-upload-core-<السيناريو>-100mb.json`. أدوات netlab تُستورد كما هي ولا تُنسخ.

- المعيار المرحلي (أ) لـ `field-network-upload`: `efficiency_vs_mathis ≥ 0.70` و`bytes_lost_on_resume = 0`
  وبصمة الخادم مطابقة؛ النتيجة `partial` في أحسن الأحوال (المرحلة (ب) على جهاز حقيقي وحدها تعطي `pass`).
- يعمل في وظيفة `android-upload-core` من سير العمل `netlab` على طلبات السحب التي تمس `apps/android/core`
  أو هذا المجلد، وملفات النتيجة artifact يُلتزم بها في `docs/measurements/netlab/`.
- محليًا يحتاج docker (compose + netlab)؛ `--tus-url` يتجاوز netlab لتجربة الـ runner فقط (النتيجة `info` ولا تُلتزم).

```bash
cd apps/android && ./gradlew :netlab-runner:installDist && cd ../..
python3 apps/android/netlab/measure.py --scenario field-weak --size-mb 100 --max-seconds 2100 \
  --out docs/measurements/netlab/$(date -u +%F)-android-upload-core-field-weak-100mb.json
```
