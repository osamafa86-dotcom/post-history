package net.palpost.library.ui.material

import kotlin.coroutines.cancellation.CancellationException

/**
 * إرسال الدفعة: لكل ملف مادة مستقلة ثم صف رفع، بالترتيب. المنطق صِرف ليُختبر على JVM بلا شبكة ولا Room.
 *
 * القاعدة: لا يُنشأ شيء ولا يُدرج مرتين، حتى لو قُتلت العملية في أي لحظة. لذلك تُكتب المسودة (الملفات المتبقية
 * ومعها معرّفات موادها) عبر `persist` في كل خطوة، والترتيب فيها هو الضمان:
 * 1. قبل الحلقة: كل الملفات كما هي (البيانات والمفاتيح محفوظة قبل أول طلب).
 * 2. بعد إنشاء المادة وقبل إدراج الصف: الملف ومعه `createdMaterialId` (فإعادة التشغيل لا تنشئها ثانية).
 * 3. بعد إدراج الصف: بقية الملفات بدون هذا الملف (فإن قُتلت العملية بين الإدراج والكتابة فالإعادة تكتب الصف نفسه، لأن
 *    معرّفه مشتق من المادة ولا يُصفَّر صف تقدّم).
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
     * @param persist يحفظ القائمة المتبقية (مسودة) ويحدّث الواجهة؛ يُستدعى بالترتيب الموصوف أعلاه، وفشله يوقف الدفعة.
     */
    suspend fun run(
        files: List<PickedOriginal>,
        createMaterial: suspend (PickedOriginal) -> String,
        enqueue: suspend (PickedOriginal, String) -> String,
        persist: suspend (List<PickedOriginal>) -> Unit = {},
    ): Result {
        var remaining = files
        val queued = ArrayList<String>()
        try {
            persist(remaining)
            while (remaining.isNotEmpty()) {
                var file = remaining.first()
                if (file.createdMaterialId == null) {
                    val created = createMaterial(file)
                    file = file.copy(createdMaterialId = created)
                    remaining = listOf(file) + remaining.drop(1)
                    persist(remaining)
                }
                queued.add(enqueue(file, file.createdMaterialId!!))
                remaining = remaining.drop(1)
                persist(remaining)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            return Result(remaining, queued, t)
        }
        return Result(emptyList(), queued, null)
    }
}
