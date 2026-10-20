# workers/ai — عامل التفريغ المحلي

يفرّغ النسخة الخفيفة لكل أصل متحقق منه بـ faster-whisper large-v3-turbo (int8، Silero VAD، طوابع الكلمات)، ويسجّل مسودتين مشتقتين. القرارات في ADR 0020، والبيئة في ADR 0019، واختيار النموذج في `docs/measurements/asr-bench/REPORT.md`.

## التدفق

1. **الحدث:** `media:events` بمجموعة `ai`، وحدث `upload.verified` لأصل (`kind=original`). غيره يُتجاهل.
2. **المصدر:** `derived/<material_id>/<file_id>/proxy-480p.mp4` من حاوية المشتقات.
   - إن غابت يُؤجَّل الحدث في `ai:retry` بتراجع أسّي (30 ث حتى 10 دقائق) دون أن يحجب غيره.
   - بعد `AI_SOURCE_WAIT_S` يُسجَّل تعذّره في `ai:dead` بسبب `no_source`.
   - العامل لا يقرأ نسخة الهاتف. عامل الوسائط يصنع نسخة الخادم لكل أصل مرئي متحقق منه (قرار المنسّق، ADR 0020).
3. **الناتج:** في المسار نفسه:
   - `transcript.json`: مسودة بالمقاطع والكلمات وطوابعها، و`route: local`، وبصمة الأوزان.
   - `transcript.vtt`: WebVTT عربي، كل سطر يبدأ بـ RLM، وكل عبارة تبدأ من أول كلمة فيها.
4. **التسجيل:** `POST /internal/media/files/{file_id}/derivatives` بنوعي `transcript` و`captions`.

**الضوابط:**
- الناتج مسودة، والمادة لا تُعدَّل ولا يُنشر شيء.
- العامل بلا خروج شبكي ولا كود لمزوّد خارجي، فالمواد الموسومة بالحساسية لا تغادر الحاوية.
- السجل معرّفات ونتائج فقط، لا نص التفريغ.

## الإعداد

| المتغير | الافتراضي | المعنى |
| --- | --- | --- |
| `AI_ENABLE_TRANSCRIPT` | `false` | يشغّل التفريغ؛ يبقى مطفأ إلى أن يقبل الخادم الرمز والحدث (النوعان في عقد v0.2) |
| `REDIS_URL`، `AI_API_URL`، `AI_WORKER_TOKEN` | — | الطابور والخادم (الرمز ≥ 32 حرفًا، لا يُسجَّل) |
| `S3_ENDPOINT`، `S3_ACCESS_KEY`، `S3_SECRET_KEY`، `S3_BUCKET_MEDIA` | — | حاوية المشتقات وحدها |
| `AI_MODELS_DIR`، `AI_MODEL` | `/models`، `faster-whisper-large-v3-turbo` | الأوزان من حجم `ai-models` |
| `AI_CPU_THREADS` | `0` (تلقائي) | خيوط CTranslate2 |
| `AI_SOURCE_WAIT_S`، `AI_CLAIM_IDLE_MS`، `AI_MAX_DELIVERIES` | 3600، 30 دقيقة، 5 | مهلة انتظار المصدر (بلا حجب)، وإعادة المحاولة |

## التشغيل والاختبار

```bash
docker build --target test -t ai-worker:test workers/ai
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL ai-worker:test     # بلا أوزان: اختبار المحرك يُتخطى
# مع أوزان tiny مثبّتة البصمة (tests/models.sha256)، كما في سير ai-worker:
docker run --rm --network none -v <tiny>:/models/tiny:ro -e AI_IT_MODEL_DIR=/models/tiny -e AI_IT_REQUIRED=1 ai-worker:test
```

**القياس:** `bench/transcribe_bench.py` (مقطع دقيقتين في الحاوية المحصّنة). النتائج في `docs/measurements/asr-bench/*-transcribe-worker-*.json`:
- على معالجين: RTF 0.58 وذروة 1.99 GB.
- على أربعة: RTF 0.46.

## ما ينتظر غيري (ADR 0020)

- **الخادم:** `upload.verified` في `media:events`، و`AI_WORKER_TOKEN`، و`172.30.251.3` في `INTERNAL_ALLOWED_CIDRS`.
- **البنية:** مستخدم MinIO للعامل، وخدمة `ai-worker` في compose على هذه الصورة.
