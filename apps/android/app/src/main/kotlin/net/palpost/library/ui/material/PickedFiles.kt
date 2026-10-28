package net.palpost.library.ui.material

/**
 * ملف أصلي اختاره المراسل: يُحفظ رابط محتوى دائم الصلاحية ولا يُنسخ (قاعدة الحزمة). الرابط نصٌّ لا `Uri` ليبقى
 * المنطق كله قابلًا للاختبار على JVM بلا إطار أندرويد.
 *
 * كل ملف يصير مادة مستقلة بالبيانات المشتركة نفسها (الخادم يحتفظ بأصل واحد للمادة؛ ADR 0082)، فيحمل هو ما يلزم لئلا
 * يتكرر شيء عند إعادة المحاولة. الحقول الأربعة الأخيرة تُحفظ في المسودة، وقيمتها الافتراضية null عند القراءة:
 * - [materialKey]: `Idempotency-Key` إنشاء مادة هذا الملف، ثابت عبر المحاولات.
 * - [createdMaterialId]: معرّف المادة بعد إنشائها؛ إن وُجد فلا يُنشأ ثانية.
 * - [position] و[total]: ترتيب الملف وعدد الملفات حين بدأ الإرسال (لاحقة العنوان `(i/N)`)، فلا تتغير الأرقام بعد
 *   إخراج الملفات المرسلة من المسودة.
 */
data class PickedOriginal(
    val uri: String,
    val name: String,
    val sizeBytes: Long,
    val mimeType: String?,
    val materialKey: String? = null,
    val createdMaterialId: String? = null,
    val position: Int? = null,
    val total: Int? = null,
) {
    val isVideo: Boolean get() = mimeType?.startsWith("video/") == true
}

/** قائمة الملفات الأصلية: بيانات واحدة يملؤها المراسل مرة، ومادة مستقلة لكل ملف. */
object PickedFiles {
    /** الحد الأقصى للملفات في الدفعة الواحدة (قرار المنسّق، ADR 0082). */
    const val MAX = 20

    /** نتيجة إضافة اختيار جديد: القائمة الجديدة وما لم يدخل ولماذا، ليُخبَر المراسل ولا يُسقَط ملف بصمت. */
    data class Added(val files: List<PickedOriginal>, val added: Int, val duplicates: Int, val overLimit: Int)

    fun remaining(current: List<PickedOriginal>): Int = (MAX - current.size).coerceAtLeast(0)

    /** يُلحق الجديد بالترتيب الذي اختاره المراسل؛ يتجاهل المكرر (الرابط نفسه) ويقتطع ما زاد على الحد. */
    fun add(current: List<PickedOriginal>, incoming: List<PickedOriginal>): Added {
        val seen = current.mapTo(HashSet()) { it.uri }
        val result = current.toMutableList()
        var added = 0
        var duplicates = 0
        var overLimit = 0
        for (f in incoming) {
            when {
                !seen.add(f.uri) -> duplicates++
                result.size >= MAX -> overLimit++
                else -> { result.add(f); added++ }
            }
        }
        return Added(result, added, duplicates, overLimit)
    }

    /** إزالة صف من القائمة؛ لا يمسّ الملف على الهاتف ولا شيئًا في قائمة الرفع. */
    fun remove(current: List<PickedOriginal>, uri: String): List<PickedOriginal> = current.filterNot { it.uri == uri }

    /** مجموع الأحجام المعروفة؛ الحجم غير المعروف (صفر أو سالب) لا يدخل. */
    fun totalBytes(files: List<PickedOriginal>): Long = files.sumOf { it.sizeBytes.coerceAtLeast(0) }

    /**
     * يعطي كل ملف بلا مفتاح مفتاح إنشاء ثابتًا: المسودة القديمة (ملف واحد، ولا مفتاح فيها) تأخذ مفتاح المسودة
     * [draftKey]، وما سواها مفتاحًا جديدًا من [generate]. من لديه مفتاح يبقى كما هو.
     */
    fun stampKeys(files: List<PickedOriginal>, draftKey: String, generate: () -> String): List<PickedOriginal> =
        files.map { if (it.materialKey != null) it else it.copy(materialKey = if (files.size == 1) draftKey else generate()) }

    /** عدد الملفات الذي تُحسب عليه لاحقة العنوان: العدد الحالي أو العدد الذي بدأ به إرسال سابق إن كان أكبر. */
    fun groupSize(files: List<PickedOriginal>): Int = maxOf(files.size, files.maxOfOrNull { it.total ?: 0 } ?: 0)

    /**
     * يرقّم الملفات للإرسال. من رُقّم في محاولة سابقة يحتفظ برقمه؛ وغير المرقّم يتابع بعد أكبر رقم موجود، وعدد الدفعة
     * كلها لا ينقص عن آخر رقم. أول إرسال: 1..n من n.
     */
    fun assignPositions(files: List<PickedOriginal>): List<PickedOriginal> {
        var next = (files.maxOfOrNull { it.position ?: 0 } ?: 0) + 1
        val total = maxOf(groupSize(files), next - 1 + files.count { it.position == null })
        return files.map { if (it.position != null) it else it.copy(position = next++, total = total) }
    }
}

/** عنوان كل مادة حين تُنشأ عدة مواد من إدخال واحد: `<العنوان> (i/N)` بأرقام لاتينية، ودون لاحقة لملف واحد. */
object MaterialTitles {
    const val MIN = 5
    const val MAX = 80

    /** اللاحقة المخزَّنة في العنوان؛ فارغة لملف واحد. أرقام ASCII فقط ولا محارف اتجاه مخفية في العنوان المرسل. */
    fun suffix(position: Int, total: Int): String = if (total <= 1) "" else " ($position/$total)"

    /** أطول لاحقة ممكنة لدفعة من [total] ملفات (الرقم الأخير هو الأطول). */
    fun longestSuffix(total: Int): String = suffix(total, total)

    /** أطول عنوان أساسي يتسع مع أطول لاحقة ضمن [MAX]. */
    fun maxBase(total: Int): Int = MAX - longestSuffix(total).length

    fun titleFor(base: String, position: Int, total: Int): String = base + suffix(position, total)

    /** عدد الأحرف كما يعدّها الخادم (نقاط ترميز). */
    fun length(s: String): Int = s.codePointCount(0, s.length)

    fun baseValid(base: String, total: Int): Boolean = length(base) in MIN..maxBase(total)
}

/**
 * معرّفات صف الطابور ومفتاح جلسته مشتقة من معرّف المادة: لكل مادة أصل واحد، فيعيد أي تكرار للإرسال (حتى بعد قتل
 * العملية) كتابة الصف نفسه ولا يضيف صفًا ثانيًا.
 */
object UploadIds {
    fun taskId(materialId: String): String = java.util.UUID.nameUUIDFromBytes("task:original:$materialId".toByteArray(Charsets.UTF_8)).toString()
    fun sessionKey(materialId: String): String = java.util.UUID.nameUUIDFromBytes("session:original:$materialId".toByteArray(Charsets.UTF_8)).toString()
}
