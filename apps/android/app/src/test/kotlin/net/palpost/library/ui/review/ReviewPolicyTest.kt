package net.palpost.library.ui.review

import net.palpost.library.api.infrastructure.ClientError
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.infrastructure.ServerError
import net.palpost.library.api.infrastructure.ServerException
import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.Material
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

class ReviewPolicyTest {
    @Test
    fun `actions are the supervisor rows of the contract table, editorial track only`() {
        assertEquals(listOf(ReviewAction.ACKNOWLEDGE, ReviewAction.REJECT), ReviewPolicy.actionsFor(EditorialState.inbox))
        assertEquals(listOf(ReviewAction.START_REVIEW, ReviewAction.REJECT), ReviewPolicy.actionsFor(EditorialState.acknowledged))
        assertEquals(listOf(ReviewAction.ACCEPT, ReviewAction.REQUEST_CHANGES, ReviewAction.REJECT), ReviewPolicy.actionsFor(EditorialState.reviewing))
        // needs_changes → reviewing is the reporter's; accepted onward belongs to production and the editor in chief.
        for (s in listOf(EditorialState.needs_changes, EditorialState.accepted, EditorialState.in_production, EditorialState.final_review, EditorialState.published, EditorialState.rejected)) {
            assertEquals(emptyList<ReviewAction>(), ReviewPolicy.actionsFor(s))
        }
        assertEquals(EditorialState.needs_changes, ReviewAction.REQUEST_CHANGES.to)
    }

    @Test
    fun `the reason is required, trimmed and within the contract's length`() {
        assertNull(ReviewPolicy.reason(""))
        assertNull(ReviewPolicy.reason("   \n"))
        assertNull(ReviewPolicy.reason("x".repeat(ReviewPolicy.REASON_MAX + 1)))
        assertEquals("الصوت ضعيف", ReviewPolicy.reason("  الصوت ضعيف \n"))
        assertEquals(ReviewPolicy.REASON_MAX, ReviewPolicy.reason("x".repeat(ReviewPolicy.REASON_MAX))!!.length)
    }

    @Test
    fun `if-match carries the row version the supervisor saw`() {
        assertEquals("\"7\"", ReviewPolicy.ifMatch(material("normal", rowVersion = 7)))
        assertNull(ReviewPolicy.ifMatch(material("normal", rowVersion = null)))
    }

    @Test
    fun `urgent first, server order otherwise`() {
        val a = material("normal", title = "a")
        val b = material("urgent", title = "b")
        val c = material("important", title = "c")
        val d = material("urgent", title = "d")
        assertEquals(listOf("b", "d", "a", "c"), ReviewPolicy.ordered(listOf(a, b, c, d)).map { it.title })
    }

    @Test
    fun `a stale view or a decision already made reloads, the network keeps the decision to retry`() {
        assertEquals(ReviewPolicy.Outcome.DONE, ReviewPolicy.outcomeOf(null))
        assertEquals(ReviewPolicy.Outcome.STALE, ReviewPolicy.outcomeOf(client(412, "precondition_failed")))
        assertEquals(ReviewPolicy.Outcome.STALE, ReviewPolicy.outcomeOf(client(409, "invalid_transition")))
        assertEquals(ReviewPolicy.Outcome.FORBIDDEN, ReviewPolicy.outcomeOf(client(403, "forbidden")))
        assertEquals(ReviewPolicy.Outcome.FAILED, ReviewPolicy.outcomeOf(client(422, "validation_failed")))
        assertEquals(ReviewPolicy.Outcome.RETRY, ReviewPolicy.outcomeOf(client(429, "rate_limited")))
        assertEquals(ReviewPolicy.Outcome.RETRY, ReviewPolicy.outcomeOf(ServerException("x", 503, ServerError<Any>(body = "{}", statusCode = 503))))
        assertEquals(ReviewPolicy.Outcome.RETRY, ReviewPolicy.outcomeOf(IOException("offline")))
    }

    private fun client(status: Int, code: String) =
        ClientException("x", status, ClientError<Any>(body = """{"code":"$code","message":"m"}""", statusCode = status))

    private fun material(priority: String, title: String = "t", rowVersion: Long? = 1): Material {
        val rv = rowVersion?.let { ""","row_version":$it""" } ?: ""
        val json = """{"title":"$title","material_types":["report"],"governorate":"g","city":"c","priority":"$priority",
            "sensitivity":{"minors":false,"injured":false,"graphic":false},"display_name":{"mode":"real_name"},"form_version":1,
            "dynamic_fields":{},"id":"00000000-0000-0000-0000-00000000000${title.length}","version":1,
            "reporter_id":"00000000-0000-0000-0000-000000000001","office_id":null,"technical_state":"verified",
            "editorial_state":"inbox","rights_state":"unknown","files":[],"created_at":"2026-10-21T10:00:00Z",
            "updated_at":"2026-10-21T10:00:00Z"$rv}"""
        return Serializer.moshi.adapter(Material::class.java).fromJson(json)!!
    }
}
