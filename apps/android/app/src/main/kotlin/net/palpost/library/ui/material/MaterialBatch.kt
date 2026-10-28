package net.palpost.library.ui.material

import kotlin.coroutines.cancellation.CancellationException

/**
 * إرسال الدفعة: لكل ملف مادة مستقلة ثم صف رفع، بالترتيب. المنطق صِرف ليُختبر على JVM بلا شبكة ولا Room.
 *
 * القاعدة: لا يُنشأ شيء ولا يُدرج مرتين.
 * - من له [PickedOriginal.createdMaterialId] لا تُنشأ مادته ثانية.
 * - الملف الذي أُدرج صفّه يخرج من [Result.remaining] فورًا.
 * - عند أول فشل يتوقف الإرسال، وتبقى في [Result.remaining] بقية الملفات (أولها الفاشل ومعه معرّف مادته إن كانت
 *   قد أُنشئت)، وهي ما تُحفظ مسودة؛ فإعادة التشغيل بها تكمل من حيث توقفت.
 */
object MaterialBatch {
    /**
     * @property remaining ما لم يُدرج صفّه بعد، بالترتيب نفسه.
     * @property queuedTaskIds معرّفات صفوف الرفع التي أُدرجت في هذا التشغيل، بالترتيب.
     * @property failure أول خطأ أوقف الدفعة، أو null إن اكتملت.
     */
    data class Result(val remaining: List<PickedOriginal>, val queuedTaskIds: List<String>, val failure: Throwable?)

    /**
     * @param createMaterial ينشئ مادة الملف بمفتاحه ويعيد معرّفها.
     * @param enqueue يُدرج صف رفع الملف على مادته ويعيد معرّف الصف.
     * @param onProgress يُستدعى بعد كل خطوة تغيّر [Result.remaining] (إنشاء مادة أو إدراج صف)، ليظهر الباقي في الواجهة.
     */
    suspend fun run(
        files: List<PickedOriginal>,
        createMaterial: suspend (PickedOriginal) -> String,
        enqueue: suspend (PickedOriginal, String) -> String,
        onProgress: (List<PickedOriginal>) -> Unit = {},
    ): Result {
        var remaining = files
        val queued = ArrayList<String>()
        try {
            while (remaining.isNotEmpty()) {
                var file = remaining.first()
                val existing = file.createdMaterialId
                if (existing == null) {
                    val created = createMaterial(file)
                    file = file.copy(createdMaterialId = created)
                    remaining = listOf(file) + remaining.drop(1)
                    onProgress(remaining)
                }
                queued.add(enqueue(file, file.createdMaterialId!!))
                remaining = remaining.drop(1)
                onProgress(remaining)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            return Result(remaining, queued, t)
        }
        return Result(emptyList(), queued, null)
    }
}
