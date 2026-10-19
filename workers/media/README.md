# workers/media

عامل الوسائط (Python 3.12 + FFmpeg 8.0.1). الاتفاقيات في `CLAUDE.md`، والواجهة مع الخادم في ADR 0006.

## البصمة الرخيصة (`client_fingerprint`)

ما يحسبه العامل وما يجب أن يحسبه تطبيقا الهاتف حرفيًا حتى تتطابق القيم:

- `size_bytes`: حجم الملف بالبايت.
- `head_sha256`: SHA-256 لأول **1 MiB = 1,048,576 بايت** (لا 1,000,000).
- `tail_sha256`: SHA-256 لآخر 1 MiB.
- ملف أصغر من 1 MiB: الرأس والذيل كلاهما الملف كله.
- القيم بأحرف hex صغيرة.

البصمة الرخيصة ترشّح المكررات فقط ولا تمنح حقًا؛ الربط بملف موجود لا يتم إلا بتطابق SHA-256 الكاملة على الخادم. «ميغابايت» في العقد تعني 1 MiB، ويُثبَّت ذلك في `contracts/` بعد التجميد.

## التشغيل

```bash
docker build --target test -t media-worker:test workers/media && docker run --rm media-worker:test
python -m media_worker {probe,digest,proxy} FILE [OUT]   # داخل الصورة
```
