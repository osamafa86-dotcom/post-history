package net.palpost.library.ui.material

/**
 * ملف أصلي اختاره المراسل: يُحفظ رابط محتوى دائم الصلاحية ولا يُنسخ (قاعدة الحزمة). الرابط نصٌّ لا `Uri` ليبقى
 * المنطق كله قابلًا للاختبار على JVM بلا إطار أندرويد.
 */
data class PickedOriginal(val uri: String, val name: String, val sizeBytes: Long, val mimeType: String?) {
    val isVideo: Boolean get() = mimeType?.startsWith("video/") == true
}

/** قائمة الملفات الأصلية للمادة الواحدة: كلها تحت عنوان واحد ونموذج واحد، وجلسة رفع `original` لكل ملف. */
object PickedFiles {
    /** الحد الأقصى للملفات في المادة الواحدة (قرار المنسّق، ADR 0082). */
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
}
