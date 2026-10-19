# نتائج القياس

كل أداة قياس (netlab، asr-bench، render-bench، acceptance، تطبيقا الهاتف) تكتب نتائجها هنا بصيغة JSON مطابقة لمخطط `contracts/schemas/measurement.json`.

- اسم الملف: `<tool>/<YYYY-MM-DD>-<slug>.json` (مثال: `netlab/2026-11-03-tusd-xiaomi-redmi12.json`).
- ملف واحد لكل تشغيل؛ لا يُعدَّل بعد كتابته، والتشغيل المكرر ملف جديد.
- لا بيانات كاشفة في النتائج: لا أسماء مراسلين ولا مواقع ولا معرّفات أجهزة؛ يكفي طراز الجهاز والإصدار.
- مراجعة البوابة في نهاية التأسيس تُبنى على هذه الملفات لا على الانطباعات.

التحقق محليًا:

```bash
npx -y -p ajv-cli@5.0.0 -p ajv-formats@2.1.1 ajv validate --spec=draft2020 -c ajv-formats -s contracts/schemas/measurement.json -d "docs/measurements/**/*.json"
```
