# تشغيل أحجام الخطة (يدوي)

CI يشغّل الاختبارات بأحجام صغيرة تثبت الآلية. معيار البوابة أحجام الخطة، وتُشغَّل هنا على مجموعة compose كاملة، ونتيجتها تُرفق في `docs/measurements/acceptance/` بملف جديد لكل تشغيل.

## المتطلبات

- `docker compose -f infra/compose/docker-compose.yml up -d --wait` وبناء الخادم (`apps/api`) وتشغيله على المنفذ الذي يشير إليه `TUSD_HOOK_URL`، والقيمة نفسها لـ `TUSD_HOOK_SECRET` و`TUSD_OBJECT_PREFIX` و`S3_*`.
- قاعدة بيانات مرحَّلة، ورموز لكل دور (يخرجها `live/seed.mjs` على قاعدة اصطناعية فقط).
- قرص حر بحجم الملفات: `concurrent-load` على 60 × 2 غيغابايت يكتب 120 غيغابايت في التخزين ويقرؤها الخادم للتحقق.

## الأوامر

```bash
# استئناف الرفع: 5 غيغابايت، ثلاثة انقطاعات، البصمة من MinIO (tusd بلا تنزيل)
UPLOAD_ENDPOINT=http://127.0.0.1:8080/files/ UPLOAD_SIZE_MB=5120 \
UPLOAD_S3_ENDPOINT=http://127.0.0.1:9000 UPLOAD_S3_ACCESS_KEY=$S3_ACCESS_KEY UPLOAD_S3_SECRET_KEY=$S3_SECRET_KEY \
UPLOAD_S3_BUCKET=$S3_BUCKET_UPLOADS UPLOAD_S3_PREFIX=$TUSD_OBJECT_PREFIX node run.mjs upload-resume

# الحمل المتزامن: 60 رفعًا بملفات 2 غيغابايت عبر tusd الحقيقي (الخادم يتحقق ويرسل الإيصال)
LOAD_MODE=tus LOAD_TUS_ENDPOINT=http://127.0.0.1:8080/files/ LOAD_CONCURRENCY=60 LOAD_SIZE_MB=2048 \
LOAD_API_URL=… LOAD_TOKENS=… HOOK_BASE_URL=… HOOK_TOKEN=… S3_ENDPOINT=… S3_ACCESS_KEY=… S3_SECRET_KEY=… node run.mjs concurrent-load
```

`UPLOAD_SIZE_MB=5120` وحده يرفع نتيجة `upload-resume` إلى `pass` إن تحقق كل شيء. أما `concurrent-load` فيبقى `partial` ما لم يُقَس قرص خادم الرفع المؤقت (لا أداة له بعد)، ومعيار «لا تدهور» افتراضي من الجودة (انظر رأس السكربت) إلى أن تحدد الخطة رقمًا.

## ما جُرِّب

مسار `LOAD_MODE=tus` جُرِّب محليًا بـ tusd الرسمي على S3 (محاكي) وخطّافات إلى الخادم بملفات 20 ميغابايت × 6. أحجام الخطة لم تُشغَّل بعد.
