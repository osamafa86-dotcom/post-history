package net.palpost.library.core.forms

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs the shared suite tools/acceptance/form-conformance/cases.json through FormValidator and writes
 * `android.json` (the per-platform result file `run.mjs --compare` consumes). The suite is read from the
 * repository checkout (system property `conformance.dir`), never copied here.
 */
class FormConformanceTest {
    private val dir = File(System.getProperty("conformance.dir") ?: error("conformance.dir not set"))
    private val outDir = File(System.getProperty("conformance.out") ?: error("conformance.out not set"))
    private val mapAdapter = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java))
    private val formAdapter = Serializer.moshi.adapter(UploadForm::class.java)

    @Suppress("UNCHECKED_CAST")
    @Test
    fun everyCaseMatchesTheSharedExpectation() {
        val suite = mapAdapter.fromJson(File(dir, "cases.json").readText())!!
        val forms = (suite["forms"] as Map<String, String>).mapValues { (_, rel) -> formAdapter.fromJson(File(dir, rel).readText())!! }
        val cases = suite["cases"] as List<Map<String, Any?>>
        val results = LinkedHashMap<String, Map<String, Any?>>()
        val mismatches = ArrayList<String>()
        for (c in cases) {
            val id = c["id"] as String
            val form = forms.getValue(c["form"] as String)
            val materialType = MaterialType.decode(c["material_type"]) ?: error("$id: unknown material type")
            val got = FormValidator.validate(form, materialType, c["values"] as Map<String, Any?>)
            val expect = c["expect"] as Map<String, Any?>
            val expectedErrors = (expect["errors"] as List<Map<String, Any?>>).map { FieldError(it["field"] as String, it["code"] as String) }
            val gotNorm = got.errors.sortedWith(compareBy({ it.field }, { it.code }))
            val expNorm = expectedErrors.sortedWith(compareBy({ it.field }, { it.code }))
            if (got.valid != expect["valid"] || gotNorm != expNorm) mismatches.add("$id: expected $expNorm got ${got.errors}")
            // Order is part of the contract too: errors come in form field order.
            if (got.errors != expectedErrors) mismatches.add("$id: order differs: expected $expectedErrors got ${got.errors}")
            results[id] = mapOf("valid" to got.valid, "errors" to got.errors.map { mapOf("field" to it.field, "code" to it.code) })
        }
        outDir.mkdirs()
        File(outDir, "android.json").writeText(mapAdapter.indent(" ").toJson(mapOf("platform" to "android", "results" to results)) + "\n")
        assertTrue(mismatches.joinToString("\n"), mismatches.isEmpty())
        assertEquals(cases.size, results.size)
    }
}
