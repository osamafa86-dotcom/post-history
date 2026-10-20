# قياس نواة الرفع (أندرويد) عبر netlab

`measure.sh` يقيس `UploadEngine` الحقيقي من `apps/android/core` على JVM (وحدة `apps/android/netlab-runner`) بأداة
`tools/netlab/netlab.py run --client-cmd` (ADR 0007): netlab يعدّ الملف الاصطناعي ويهيّئ toxiproxy وnetem ومشغّل
الأحداث، ويشغّل أولًا عميل بايثون المرجعي بالشروط نفسها (`--reference-seconds`)، ثم الـ runner الذي يطبع في آخر سطر ملخص
الجلسة بعقد العميل الخارجي (`url_path`، `offset`، `complete`، `parts` = `[زمن طلب PATCH، بايتاته، نجح؟]` والطلب
المقطوع جزء فاشل، `windows`، `resumes` = كل `HEAD` بعد فشل، `failures`، `bytes_lost`، ومفتاح إضافي `device_sha256`).
المقاييس والكفاءة نسبةً إلى المرجع وبصمة MinIO والحكم كلها من netlab؛ لا حساب موازٍ هنا.

- المعيار المرحلي (أ) لـ `field-network-upload` (ADR 0007، تعديل 2026-10-20): `efficiency_vs_reference ≥ 0.70`
  و`bytes_lost_on_resume = 0` وبصمة مطابقة إن اكتمل الرفع، على netem؛ `efficiency_vs_mathis` إعلامي. النتيجة
  `partial` إن تحقق المعيار و`fail` إن لم يتحقق؛ `pass` للمرحلة (ب) على جهاز حقيقي وحدها.
- حجم طلب PATCH في النواة يتكيّف مع السرعة المرصودة (`RequestSizer`؛ ADR 0010): نحو 40 ثانية للطلب بين 256 كيلوبايت
  (جزء المرجع على field-weak) وحجم جزء الجلسة (`{chunk}` من السيناريو).
- سير العمل `netlab-android` (`.github/workflows/netlab-android.yml`): على طلبات السحب التي تمس `apps/android/core` أو
  الـ runner أو هذا المجلد أو `netlab.py` سيناريو واحد قصير (office، 100 MB، 240 ث، بلا مرجع) للتحقق من أن المشغّل يعمل
  ويكتب نتيجة صالحة؛ القياس الكامل بـ `workflow_dispatch` وحده (السيناريوهات الثلاثة بأحجام لكل سيناريو مع المرجع في
  التشغيل نفسه)، والنتيجة artifact يُلتزم بها في `docs/measurements/netlab/` باسم
  `<التاريخ>-tusd-<السيناريو>-<الحجم>mb-android-core-gha.json`.
- محليًا يحتاج docker (compose + طبقة netlab).

```bash
apps/android/netlab/measure.sh build
docker compose -f infra/compose/docker-compose.yml -f tools/netlab/compose.netlab.yml up -d --wait
apps/android/netlab/measure.sh measure field-weak 20 6000 1200 \
  docs/measurements/netlab/$(date -u +%F)-tusd-field-weak-20mb-android-core-gha.json
```
