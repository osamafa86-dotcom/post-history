package net.palpost.library.ui.uploads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A failed upload is explained in the reporter's words: what happened, then the step, without the words server, fingerprint or
 * session. And a title that is cut by a line limit ends with an ellipsis. Both are read from the sources, so they hold on the JVM.
 */
class UploadWordsTest {
    private val failures = listOf(
        "upload_failure_session_expired", "upload_failure_checksum", "upload_failure_invalid_file", "upload_failure_rejected",
        "upload_failure_file_unavailable", "upload_failure_storage", "upload_failure_aborted", "upload_failure_device_not_trusted",
        "upload_failure_unknown",
    )

    private fun strings(folder: String): Map<String, String> =
        Regex("""<string name="([a-z0-9_]+)">(.*?)</string>""").findAll(File("src/main/res/$folder/strings.xml").readText())
            .associate { it.groupValues[1] to it.groupValues[2] }

    @Test
    fun `every failure reason says what happened and the step, in both languages`() {
        val arabic = strings("values")
        val english = strings("values-en")
        for (name in failures) {
            val ar = arabic.getValue(name)
            val en = english.getValue(name)
            for (word in listOf("خادم", "بصمة", "جلسة")) assertFalse("$name says $word", ar.contains(word))
            for (word in listOf("server", "fingerprint", "session")) assertFalse("$name says $word", en.lowercase().contains(word))
            assertTrue("$name: what happened, then the step", ar.count { it == '.' } >= 2)
            assertTrue("$name: what happened, then the step", en.count { it == '.' } >= 2)
        }
    }

    @Test
    fun `every line-limited text ends a cut title with an ellipsis`() {
        val cut = File("src/main/kotlin").walkTopDown().filter { it.extension == "kt" }
            .flatMap { file -> file.readLines().mapIndexedNotNull { i, line -> if ("maxLines =" in line && "TextOverflow.Ellipsis" !in line) "${file.name}:${i + 1}" else null } }
            .toList()
        assertEquals(emptyList<String>(), cut)
    }
}
