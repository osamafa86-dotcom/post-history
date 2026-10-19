package net.palpost.library.ui.forms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldInputTest {
    @Test fun `arabic indic digits become a number`() {
        assertEquals(42.0, FieldInput.numberValue("٤٢"))
        assertEquals(3.5, FieldInput.numberValue("۳٫۵"))
        assertEquals(1.25, FieldInput.numberValue("1,25"))
    }

    @Test fun `empty is missing and text stays text`() {
        assertNull(FieldInput.numberValue("   "))
        assertEquals("5a", FieldInput.numberValue("5a"))
        assertNull(FieldInput.textValue(""))
        assertEquals("   ", FieldInput.textValue("   "))
    }

    @Test fun `now is a full rfc3339 date-time with seconds`() {
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(Z|[+-]\\d{2}:\\d{2})$").matches(FieldInput.nowRfc3339()))
    }

    @Test fun `sizes read in binary units`() {
        assertEquals("1000 B", FieldInput.describeBytes(1000))
        assertEquals("1.0 MiB", FieldInput.describeBytes(1L shl 20))
    }
}
