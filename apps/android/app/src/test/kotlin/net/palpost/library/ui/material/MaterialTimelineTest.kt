package net.palpost.library.ui.material

import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.TransitionRecord
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime

class MaterialTimelineTest {
    private val t0 = OffsetDateTime.parse("2026-10-26T10:00:00Z")

    @Test
    fun `needs action means changes requested or a failed technical track, nothing else`() {
        assertTrue(MaterialTimeline.needsAction(material(editorial = "needs_changes")))
        assertTrue(MaterialTimeline.needsAction(material(technical = "failed")))
        assertFalse(MaterialTimeline.needsAction(material()))
    }

    @Test
    fun `tones per track, and an unknown value is neutral`() {
        assertEquals(Tone.GOOD, MaterialTimeline.technicalTone("verified"))
        assertEquals(Tone.BAD, MaterialTimeline.technicalTone("failed"))
        assertEquals(Tone.ATTENTION, MaterialTimeline.editorialTone("needs_changes"))
        assertEquals(Tone.PROGRESS, MaterialTimeline.editorialTone("reviewing"))
        assertEquals(Tone.GOOD, MaterialTimeline.rightsTone("sellable"))
        assertEquals(Tone.NEUTRAL, MaterialTimeline.rightsTone("listed_in_v9"))
    }

    @Test
    fun `the timeline is newest first and a filter keeps one track only`() {
        val list = listOf(
            record("technical", "verified", t0),
            record("editorial", "acknowledged", t0.plusMinutes(2)),
            record("rights", "documented", t0.plusMinutes(1)),
            record("editorial", "reviewing", t0.plusMinutes(3)),
        )
        assertEquals(listOf("reviewing", "acknowledged", "documented", "verified"), MaterialTimeline.events(list, null).map { it.to })
        assertEquals(listOf("reviewing", "acknowledged"), MaterialTimeline.events(list, Track.EDITORIAL).map { it.to })
        assertTrue(MaterialTimeline.events(list, Track.RIGHTS).all { it.track.value == "rights" })
    }

    @Test
    fun `the supervisor's note is the latest request for changes, only while changes are pending`() {
        val list = listOf(record("editorial", "needs_changes", t0, "old"), record("editorial", "needs_changes", t0.plusHours(1), "new"))
        assertEquals("new", MaterialTimeline.supervisorNote(material(editorial = "needs_changes"), list)?.reason)
        assertNull(MaterialTimeline.supervisorNote(material(editorial = "reviewing"), list))
    }

    private fun record(track: String, to: String, at: OffsetDateTime, reason: String = "r") =
        TransitionRecord(id = "$track-$to-$at", track = TransitionRecord.Track.entries.first { it.value == track }, from = "x", to = to, reason = reason, actorId = null, occurredAt = at)

    private fun material(technical: String = "verified", editorial: String = "inbox", rights: String = "unknown"): Material {
        val json = """{"title":"t","material_types":["report"],"governorate":"g","city":"c","priority":"normal",
            "sensitivity":{"minors":false,"injured":false,"graphic":false},"display_name":{"mode":"real_name"},"form_version":1,
            "dynamic_fields":{},"id":"00000000-0000-0000-0000-000000000009","version":1,
            "reporter_id":"00000000-0000-0000-0000-000000000001","office_id":null,"technical_state":"$technical",
            "editorial_state":"$editorial","rights_state":"$rights","files":[],"created_at":"2026-10-21T10:00:00Z",
            "updated_at":"2026-10-21T10:00:00Z"}"""
        return Serializer.moshi.adapter(Material::class.java).fromJson(json)!!
    }
}
