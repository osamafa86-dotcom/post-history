package net.palpost.library.core.send

import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import net.palpost.library.api.models.UploadFormField
import net.palpost.library.api.models.FieldValidation
import net.palpost.library.api.models.LocalizedText
import net.palpost.library.core.send.SendReadiness.Reason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SendRulesTest {
    private val ready = SendReadiness.Snapshot(
        fileCount = 3, title = "A field title", titleMax = 74, typeCount = 1, tags = listOf("tag"), governorate = "G", city = "C",
        sensitivity = SensitivityAnswers().answer(SensitivityGate.NO), form = FormState.READY,
    )

    @Test
    fun `nothing missing means no reason`() {
        assertNull(SendReadiness.firstReason(ready))
    }

    @Test
    fun `reasons follow the screen order`() {
        val empty = SendReadiness.Snapshot(0, "", 74, typeCount = 0, tags = emptyList(), governorate = "", city = "", sensitivity = SensitivityAnswers(), form = FormState.LOADING)
        assertEquals(
            listOf(Reason.FILES, Reason.TITLE, Reason.TYPE, Reason.TAGS, Reason.PLACE, Reason.SENSITIVITY, Reason.FORM_LOADING),
            SendReadiness.reasons(empty),
        )
        assertEquals(Reason.SENSITIVITY, SendReadiness.firstReason(ready.copy(sensitivity = SensitivityAnswers())))
        assertEquals(Reason.FOLLOWUPS, SendReadiness.firstReason(ready.copy(sensitivity = SensitivityAnswers().answer(SensitivityGate.YES))))
        assertEquals(Reason.FORM_FIELDS, SendReadiness.firstReason(ready.copy(form = FormState.MISSING_FIELDS)))
        assertEquals(Reason.FORM_INVALID, SendReadiness.firstReason(ready.copy(form = FormState.INVALID_FIELDS)))
        assertEquals(Reason.FORM_UNAVAILABLE, SendReadiness.firstReason(ready.copy(form = FormState.UNAVAILABLE)))
        assertEquals(Reason.PSEUDONYM, SendReadiness.firstReason(ready.copy(pseudonymMissing = true)))
    }

    @Test
    fun `the title must leave room for the longest suffix of the set`() {
        assertEquals(Reason.TITLE, SendReadiness.firstReason(ready.copy(title = "abcd")))
        assertEquals(Reason.TITLE, SendReadiness.firstReason(ready.copy(title = "x".repeat(81))))
        assertEquals(Reason.TITLE_TOO_LONG_FOR_SET, SendReadiness.firstReason(ready.copy(title = "x".repeat(75))))
        assertEquals(Reason.TITLE_TOO_LONG_FOR_SET, SendReadiness.firstReason(ready.copy(title = "x".repeat(74), pinnedSuffixMax = 8)))
        assertNull(SendReadiness.firstReason(ready.copy(title = "  " + "x".repeat(74) + "  ")))
    }

    @Test
    fun `a typed tag counts once committed, and one that cannot be added is named first`() {
        assertNull(SendReadiness.firstReason(ready.copy(tags = emptyList(), pendingTag = "typed")))
        assertEquals(listOf(Reason.PENDING_TAG, Reason.TAGS), SendReadiness.reasons(ready.copy(tags = emptyList(), pendingTag = "x".repeat(41))))
        assertEquals(Reason.TAGS, SendReadiness.firstReason(ready.copy(tags = emptyList())))
        assertEquals(Reason.TAGS, SendReadiness.firstReason(ready.copy(tags = listOf("a", "a"))))
    }

    @Test
    fun `no means all three false, yes asks the three with no preset answer`() {
        val no = SensitivityAnswers().answer(SensitivityGate.NO)
        assertEquals(SensitivityAnswers(SensitivityGate.NO, false, false, false), no)
        assertEquals(false, no.sensitive)
        val yes = no.answer(SensitivityGate.YES)
        assertEquals(SensitivityAnswers(SensitivityGate.YES, null, null, null), yes)
        assertTrue(yes.followupsShown)
        assertNull(yes.sensitive)
        val answered = yes.answer(SensitivityAnswers.Question.MINORS, true).answer(SensitivityAnswers.Question.INJURED, false).answer(SensitivityAnswers.Question.GRAPHIC, false)
        assertTrue(answered.complete)
        assertEquals(true, answered.sensitive)
    }

    @Test
    fun `tapping the selected answer changes nothing, and a follow-up pins yes`() {
        val partial = SensitivityAnswers().answer(SensitivityGate.YES).answer(SensitivityAnswers.Question.MINORS, false)
        assertEquals(partial, partial.answer(SensitivityGate.YES))
        // A four-step draft with partial answers stays «Yes» with its answers, never collapses to «No».
        val legacy = SensitivityAnswers(null, false, null, null)
        assertEquals(SensitivityGate.YES, legacy.effectiveGate)
        assertEquals(legacy.copy(gate = SensitivityGate.YES), legacy.answer(SensitivityGate.YES))
        assertEquals(SensitivityGate.NO, SensitivityAnswers(null, false, false, false).effectiveGate)
        assertNull(SensitivityAnswers().effectiveGate)
        val pinned = SensitivityAnswers(SensitivityGate.YES, false, false, null).answer(SensitivityAnswers.Question.GRAPHIC, false)
        assertEquals(SensitivityGate.YES, pinned.effectiveGate)
        assertEquals(false, pinned.sensitive)
    }

    private fun field(key: String, required: Boolean, validation: FieldValidation? = null) =
        UploadFormField(key = key, type = UploadFormField.Type.short_text, label = LocalizedText(key, key), required = required, validation = validation)

    @Test
    fun `the form check puts required fields first and tells missing from invalid`() {
        val form = UploadForm(
            version = 3L,
            fields = listOf(field("note", required = false, validation = FieldValidation(minLength = 4L)), field("desk", required = true)),
        )
        val empty = SendFormCheck(form, MaterialType.report, emptyMap())
        assertEquals(listOf("desk"), empty.errors.map { it.field })
        assertEquals(FormState.MISSING_FIELDS, empty.state)
        assertFalse(empty.firstIsUnderMore)
        assertTrue(empty.shownErrors(revealRequired = false).isEmpty())
        val invalid = SendFormCheck(form, MaterialType.report, mapOf("desk" to "x", "note" to "ab"))
        assertEquals(FormState.INVALID_FIELDS, invalid.state)
        assertTrue(invalid.firstIsUnderMore)
        assertEquals(listOf("note"), invalid.shownErrors(revealRequired = false).map { it.field })
        assertEquals(FormState.READY, SendFormCheck(form, MaterialType.report, mapOf("desk" to "x")).state)
    }
}
