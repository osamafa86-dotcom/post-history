# acceptance

سكربت واحد لكل صف في جدول «اختبارات القبول» في `docs/plan/الخطة-النسخة-الثالثة.md`. يملكه وكيل الجودة والقبول.

## الاتفاق

- اسم السكربت = اسم الاختبار في الخطة بالإنجليزية (`upload-resume`, `field-network-upload`, `force-quit-restart`, `concurrent-load`, `invalid-file`, `proxy-accuracy`, `receipt-notification`, `dynamic-fields`, `tenant-isolation`, `pii-leak`, `cut-export`, `duplicate-payment`, `refund`, `rights-exclusivity`, `payout`, `recovery`, `availability`, `ai-eval`, `performance`, `urgent-template-export`, `task-killers`, `timestamp-alignment`).
- كل سكربت يطبع المعيار الذي يختبره، ويكتب نتيجته بمخطط `contracts/schemas/measurement.json` في `docs/measurements/acceptance/`.
- ما يحتاج جهازًا فعليًا يُكتب سكربتًا خطوة بخطوة يجريه المشرف الميداني ويسجّل النتيجة بالمخطط نفسه.
- `form-conformance/`: اختبار المطابقة المشترك لراسم النماذج على الويب وiOS وأندرويد من مخطط واحد.
