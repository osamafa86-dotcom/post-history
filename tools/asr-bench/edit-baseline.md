# بطاقة زمن التعديل البشري (خط الأساس)

يملؤها المنتج أو المشرف في التجربة الميدانية، بطاقة لكل يوم عمل لكل منتج. الهدف في الخطة: خفض زمن التعديل 30% على الأقل بعد المسودات الآلية، مقارنة بهذا الخط. لا يُعلن الخفض قبل قياسه بالمرحلتين.

## ما يُكتب

| الحقل | المعنى |
| --- | --- |
| `phase` | `baseline` قبل المسودات الآلية، و`with-drafts` بعدها |
| `performed_on` | اليوم، `YYYY-MM-DD` |
| `producer` | رمز قصير للمنتج (`P1`). جدول الرموز عند المشرف وحده، خارج المستودع |
| `items[].material` | رمز قصير للمادة (`M07`)، لا معرّفها ولا عنوانها |
| `items[].task` | `transcript`، `captions`، `shot_list`، `title_summary`، أو `package` (المادة كاملة) |
| `items[].media_s` | مدة المادة بالثواني |
| `items[].started` / `ended` | بداية العمل ونهايته، `HH:MM` |
| `items[].paused_min` | دقائق انقطاع داخل الجلسة |
| `items[].draft_used` | هل بدأ العمل من مسودة آلية (لا في مرحلة `baseline`) |
| `observations` | ملاحظة قصيرة اختيارية، بلا أسماء ولا أرقام هواتف ولا روابط |

## التسجيل

```bash
python tools/asr-bench/edit_baseline.py record بطاقتي.json --dry-run   # تحقق
python tools/asr-bench/edit_baseline.py record بطاقتي.json             # يكتب docs/measurements/asr-bench/<اليوم>-edit-<المرحلة>-<الرمز>.json
python tools/asr-bench/edit_baseline.py compare <baseline.json> <with-drafts.json>
```

- البطاقة التي تحمل اسمًا أو معرّفًا أو حقلًا غير معروف تُرفض ولا تُسجَّل.
- `compare` يطبع الخفض لكل مهمة بالوسيط، ويعلّم `enough_items: false` إن قل العدد عن 10 مواد في أي مرحلة.
- `edit-ratio <draft.txt> <final.txt>`: نسبة الأحرف المعدَّلة بين مسودة آلية ونصها النهائي. تُحسب على جهاز المشرف، ولا يُرفع النص.
