package net.palpost.library.ui.receipt

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The receipt says what happened: the material reached the library and is saved. It does not claim an editor received it; "receive"
 * stays the editor's own act. Read from the string resources, so it holds on the JVM.
 */
class ReceiptWordsTest {
    private fun strings(folder: String): Map<String, String> =
        Regex("""<string name="([a-z0-9_]+)">(.*?)</string>""").findAll(File("src/main/res/$folder/strings.xml").readText())
            .associate { it.groupValues[1] to it.groupValues[2] }

    @Test
    fun `the receipt says the material arrived and does not claim an editor received it`() {
        val arabic = strings("values")
        val english = strings("values-en")
        for (name in listOf("receipt_body", "receipt_body_one")) {
            val ar = arabic.getValue(name)
            val en = english.getValue(name).lowercase()
            assertFalse("$name claims an editor received it", ar.contains("استلم"))
            assertFalse("$name claims an editor received it", en.contains("received"))
            assertTrue(name, ar.startsWith("وصلت"))
            assertTrue(name, ar.contains("إلى المكتبة وحُفظت"))
            assertTrue(name, en.contains("reached the library"))
        }
    }

    @Test
    fun `the receipt keeps its placeholders, the count and the title`() {
        for (folder in listOf("values", "values-en")) {
            val texts = strings(folder)
            val many = texts.getValue("receipt_body")
            assertTrue(folder, many.contains("%1\$s") && many.contains("%2\$s"))
            val one = texts.getValue("receipt_body_one")
            assertTrue(folder, one.contains("%1\$s") && !one.contains("%2\$s"))
        }
    }
}
