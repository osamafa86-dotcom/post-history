package net.palpost.library.core.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.regex.Pattern

class MaterialTagsTest {
    /** The contract's `MaterialTag` pattern, read from openapi.yaml, with ECMA-262 `\s` spelled out (Java's `\s` differs). */
    private val contract: Pattern by lazy {
        val lines = File("../../../contracts/openapi.yaml").readLines()
        val start = lines.indexOfFirst { it.trim() == "MaterialTag:" }
        val line = lines.drop(start).first { it.trim().startsWith("pattern:") }
        val yaml = line.substringAfter("pattern: \"").substringBeforeLast("\"")
        val regex = yaml.replace("\\\\", "\\")
        val ecmaSpace = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
        Pattern.compile(regex.replace("\\s", ecmaSpace))
    }

    private fun contractValid(s: String) = MaterialTagRules.length(s) in 1..40 && contract.matcher(s).matches()

    @Test
    fun `the rule matches the contract pattern character by character`() {
        val specials = listOf(0x09, 0x0A, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x200A, 0x2028, 0x202F, 0x205F, 0x3000, 0xFEFF,
            0x00, 0x1F, 0x7F, 0x85, 0x9F, 0x061C, 0x200E, 0x200F, 0x202A, 0x202E, 0x2066, 0x2069, 0x200B, 0x0627, 0x41)
        val samples = ArrayList<String>()
        for (cp in specials) {
            val c = String(Character.toChars(cp))
            samples += c
            samples += c + "\u0645"
            samples += "\u0645" + c
            samples += "\u0645" + c + "\u0645"
        }
        samples += "\u0645".repeat(40)
        samples += "\u0645".repeat(41)
        samples += "\uD83D\uDCF7".repeat(40) // 40 code points, 80 UTF-16 units
        for (s in samples) assertEquals("sample ${s.codePoints().toArray().joinToString { Integer.toHexString(it) }}", contractValid(s), MaterialTagRules.isValid(s))
    }

    @Test
    fun `normalising folds spaces, drops hidden characters and trims`() {
        assertEquals("a b", MaterialTagRules.normalize("  a\n\t b\u200F "))
        assertEquals("", MaterialTagRules.normalize("\u2066\u00A0 \u0007"))
        assertEquals("\u0634\u062A\u0627\u0621", MaterialTagRules.normalize("\u0634\u062A\u0627\u0621\u200E"))
    }

    @Test
    fun `adding says why a tag was not added`() {
        val tags = mutableListOf<String>()
        assertEquals(MaterialTagRules.AddResult.Added("Gaza"), MaterialTagRules.add(" Gaza ", tags))
        assertEquals(MaterialTagRules.AddResult.Duplicate, MaterialTagRules.add("gaza", tags))
        assertEquals(MaterialTagRules.AddResult.Empty, MaterialTagRules.add(" \u200F ", tags))
        assertEquals(MaterialTagRules.AddResult.TooLong, MaterialTagRules.add("x".repeat(41), tags))
        repeat(11) { MaterialTagRules.add("t$it", tags) }
        assertEquals(12, tags.size)
        assertEquals(MaterialTagRules.AddResult.LimitReached, MaterialTagRules.add("one more", tags))
        assertTrue(MaterialTagRules.isValidSet(tags))
    }

    @Test
    fun `a pending tag is committed on send, or stops the send when it cannot be added`() {
        val tags = mutableListOf("one")
        assertTrue(MaterialTagRules.commitPending("two", tags))
        assertEquals(listOf("one", "two"), tags)
        assertTrue(MaterialTagRules.commitPending("   ", tags))
        assertTrue(MaterialTagRules.commitPending("ONE", tags))
        assertFalse(MaterialTagRules.commitPending("y".repeat(41), tags))
        assertEquals(2, tags.size)
    }

    @Test
    fun `separators split complete tags from the rest`() {
        assertEquals(listOf("a", "b") to "c", MaterialTagRules.split("a,b\u060Cc"))
        assertEquals(emptyList<String>() to "abc", MaterialTagRules.split("abc"))
        assertEquals(listOf("a") to "", MaterialTagRules.split("a\n"))
    }

    @Test
    fun `Arabic folding ignores hamza, taa marbuta, alef maqsura and diacritics`() {
        assertEquals(ArabicFold.key("\u0627\u0645\u0627\u0631\u0647"), ArabicFold.key("\u0625\u0645\u0627\u0631\u0629"))
        assertEquals(ArabicFold.key("\u0645\u0633\u062A\u0634\u0641\u064A"), ArabicFold.key("\u0645\u064F\u0633\u062A\u0640\u0634\u0641\u0649"))
        assertEquals("news", ArabicFold.key("NEWS"))
    }

    @Test
    fun `suggestions put prefixes first and skip tags already in the send`() {
        val history = listOf("\u0645\u0633\u062A\u0634\u0641\u0649", "\u0623\u0645\u0637\u0627\u0631", "\u0634\u0627\u0631\u0639 \u0627\u0644\u0645\u0633\u062A\u0634\u0641\u0649", "\u0645\u0633\u0627\u0639\u062F\u0627\u062A")
        assertEquals(listOf(history[0], history[3], history[2]), TagSuggestions.match("\u0645\u0633", history, emptyList()))
        assertEquals(listOf(history[1], history[2], history[3]), TagSuggestions.match("", history, listOf(history[0])))
        assertEquals(listOf(history[1]), TagSuggestions.match("\u0627\u0645\u0637", history, emptyList()))
    }
}
