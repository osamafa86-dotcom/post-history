package net.palpost.library.ui.earnings

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import net.palpost.library.api.infrastructure.ClientError
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.models.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.Locale

@OptIn(ExperimentalCoroutinesApi::class)
class EarningsViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun mainDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun resetDispatcher() { Dispatchers.resetMain() }

    @Test fun `signed minor amounts keep precision and signs in both languages`() {
        val currency = balance().currency
        assertEquals("+\$12.34", formatEarningsMoney(1234, currency, Locale.US, signed = true))
        assertEquals("-\$12.34", formatEarningsMoney(-1234, currency, Locale.US, signed = true))
        assertFalse(formatEarningsMoney(0, currency, Locale.US, signed = true).startsWith("+"))
        assertTrue(formatEarningsMoney(100000000000, currency, Locale.US).contains("1,000,000,000.00"))
        val arabic = formatEarningsMoney(1234, currency, Locale.forLanguageTag("ar"), signed = true)
        assertTrue(arabic.startsWith("+")); assertTrue(arabic.contains("١٢٫٣٤"))
    }

    @Test fun `request is disabled below minimum and at zero and never calls the server`() = runTest {
        val source = FakeSource(); val vm = EarningsViewModel(source, SavedStateHandle()); vm.refresh(); advanceUntilIdle()
        assertFalse(canRequest(balance(99, 100))); assertFalse(canRequest(balance(0, 0))); assertTrue(canRequest(balance(100, 100)))
        vm.request(balance(99, 100)); vm.request(balance(0, 0)); advanceUntilIdle()
        assertTrue(source.requests.isEmpty())
    }

    @Test fun `reporter gate is checked before any earnings or payout query`() = runTest {
        val source = FakeSource().apply { role = "supervisor" }; val vm = EarningsViewModel(source, SavedStateHandle())
        vm.refresh(); advanceUntilIdle()
        assertEquals(EarningsFailure.FORBIDDEN, vm.state.value.failure); assertFalse(vm.state.value.allowed)
        assertEquals(0, source.summaryCalls); assertTrue(source.entryQueries.isEmpty()); assertTrue(source.payoutQueries.isEmpty())
    }

    @Test fun `network retry keeps exactly the same key and request body across recreation`() = runTest {
        val source = FakeSource().apply { requestError = IOException() }; val saved = SavedStateHandle()
        val vm = EarningsViewModel(source, saved); vm.refresh(); advanceUntilIdle(); vm.request(balance()); advanceUntilIdle()
        val first = source.requests.single(); assertTrue(vm.state.value.pendingAttempt)
        val restored = EarningsViewModel(source, saved); restored.refresh(); advanceUntilIdle(); restored.retryRequest(); advanceUntilIdle()
        assertEquals(first, source.requests.last()); assertEquals(2, source.requests.size)
        assertEquals(EarningsFailure.NETWORK, restored.state.value.failure)
    }

    @Test fun `one in-flight request blocks a second button press`() = runTest {
        val source = FakeSource().apply { gate = CompletableDeferred() }; val vm = EarningsViewModel(source, SavedStateHandle())
        vm.refresh(); advanceUntilIdle(); vm.request(balance()); runCurrent(); vm.request(balance()); runCurrent()
        assertEquals(1, source.requests.size); assertTrue(vm.state.value.requestBusy)
        source.gate!!.complete(Unit); advanceUntilIdle(); assertFalse(vm.state.value.requestBusy)
    }

    @Test fun `409 and 422 show safe errors without changing balances or appending a payout`() = runTest {
        for (status in listOf(409, 422)) {
            val source = FakeSource().apply { requestError = clientError(status) }; val vm = EarningsViewModel(source, SavedStateHandle())
            vm.refresh(); advanceUntilIdle(); val before = vm.state.value
            vm.request(balance()); advanceUntilIdle()
            assertEquals(before.summary, vm.state.value.summary); assertEquals(before.payouts, vm.state.value.payouts)
            assertFalse(vm.state.value.requested)
            assertEquals(if (status == 409) EarningsFailure.CONFLICT else EarningsFailure.VALIDATION, vm.state.value.failure)
            assertEquals(status == 409, vm.state.value.pendingAttempt)
            if (status == 409) { vm.retryRequest(); advanceUntilIdle(); assertEquals(source.requests.first(), source.requests.last()) }
            else { vm.request(balance()); advanceUntilIdle(); assertEquals(1, source.requests.size); assertTrue(vm.state.value.requestNeedsRefresh) }
        }
    }

    @Test fun `success reads authoritative balances and payout state instead of subtracting locally`() = runTest {
        val source = FakeSource(); val vm = EarningsViewModel(source, SavedStateHandle()); vm.refresh(); advanceUntilIdle()
        vm.request(balance()); advanceUntilIdle()
        assertEquals(2, source.summaryCalls); assertEquals(source.summaryValue, vm.state.value.summary)
        assertTrue(vm.state.value.requested); assertFalse(vm.state.value.pendingAttempt)
        assertEquals("sandbox", source.requests.single().second.channel.value)
        assertEquals(1000L, source.requests.single().second.amount.amountMinor)
    }

    @Test fun `entry filters restart the cursor and both lists page without duplicates`() = runTest {
        val source = FakeSource(); val vm = EarningsViewModel(source, SavedStateHandle()); vm.refresh(); advanceUntilIdle()
        vm.loadEntries(); vm.loadEntries(); vm.loadPayouts(); vm.loadPayouts(); advanceUntilIdle()
        assertEquals(listOf("1", "2"), vm.state.value.entries.map { it.id }); assertNull(vm.state.value.entryCursor)
        assertEquals(2, vm.state.value.payouts.size); assertNull(vm.state.value.payoutCursor)
        val currency = balance().currency; val state = PayableState.values().first { it.value == "available" }
        vm.filter(currency, state); advanceUntilIdle()
        assertEquals(Triple("USD", "available", null), source.entryQueries.last())
        assertEquals(listOf("1"), vm.state.value.entries.map { it.id }); assertEquals("next", vm.state.value.entryCursor)
    }

    @Test fun `page failure keeps its cursor and a retry reads the same page`() = runTest {
        val source = FakeSource(); val vm = EarningsViewModel(source, SavedStateHandle()); vm.refresh(); advanceUntilIdle()
        source.entriesError = IOException(); vm.loadEntries(); advanceUntilIdle()
        assertEquals("next", vm.state.value.entryCursor); assertEquals(listOf("1"), vm.state.value.entries.map { it.id })
        source.entriesError = null; vm.loadEntries(); advanceUntilIdle()
        assertEquals(listOf("1", "2"), vm.state.value.entries.map { it.id })
        assertEquals(source.entryQueries.takeLast(2).first(), source.entryQueries.last())
    }

    @Test fun `leaving clears visible data but retains an unconfirmed attempt for the same account`() = runTest {
        val source = FakeSource().apply { gate = CompletableDeferred() }; val saved = SavedStateHandle()
        val vm = EarningsViewModel(source, saved); vm.refresh(); advanceUntilIdle(); vm.request(balance()); runCurrent()
        val first = source.requests.single(); vm.leave(); runCurrent()
        assertFalse(vm.state.value.allowed); assertNull(vm.state.value.summary); assertTrue(vm.state.value.entries.isEmpty())
        assertTrue(vm.state.value.pendingAttempt); assertFalse(vm.state.value.requestBusy)
        source.gate!!.complete(Unit); vm.refresh(); advanceUntilIdle(); vm.retryRequest(); advanceUntilIdle()
        assertEquals(first, source.requests.last())
    }

    @Test fun `server forbidden clears the visible financial data`() = runTest {
        val source = FakeSource(); val vm = EarningsViewModel(source, SavedStateHandle()); vm.refresh(); advanceUntilIdle()
        source.entriesError = clientError(403); vm.loadEntries(); advanceUntilIdle()
        assertFalse(vm.state.value.allowed); assertNull(vm.state.value.summary); assertTrue(vm.state.value.entries.isEmpty()); assertTrue(vm.state.value.payouts.isEmpty())
    }

    private class FakeSource : EarningsSource {
        var role = "reporter"
        var summaryCalls = 0
        var requestError: Exception? = null
        var entriesError: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        val requests = mutableListOf<Pair<String, PayoutRequestCreate>>()
        val entryQueries = mutableListOf<Triple<String?, String?, String?>>()
        val payoutQueries = mutableListOf<String?>()
        val summaryValue = decode<EarningsSummary>("""{"user_id":"$USER","balances":[${balanceJson()}],"as_of":"2026-10-27T00:00:00Z"}""")
        override suspend fun me(): Me = decode("""{"user_id":"$USER","email":"synthetic","office_id":null,"organization_id":null,"totp_enabled":false,"credential_reset_required":false,"roles":[{"name":"$role","scopes":[]}],"permissions":[]}""")
        override suspend fun summary(): EarningsSummary { summaryCalls++; return summaryValue }
        override suspend fun entries(currency: Currency?, state: PayableState?, cursor: String?): EarningsEntryPage {
            entryQueries += Triple(currency?.value, state?.value, cursor); entriesError?.let { throw it }
            return decode("""{"items":[${entryJson(if (cursor == null) "1" else "2")}],"next_cursor":${if (cursor == null) "\"next\"" else "null"}}""")
        }
        override suspend fun payouts(cursor: String?): PayoutRequestPage {
            payoutQueries += cursor
            return decode("""{"items":[${payoutJson(if (cursor == null) USER else OTHER)}],"next_cursor":${if (cursor == null) "\"next\"" else "null"}}""")
        }
        override suspend fun request(key: String, body: PayoutRequestCreate): PayoutRequest {
            requests += key to body; gate?.await(); requestError?.let { throw it }; return decode(payoutJson(USER))
        }
    }
    companion object {
        private const val USER = "00000000-0000-0000-0000-000000000001"
        private const val OTHER = "00000000-0000-0000-0000-000000000002"
        private inline fun <reified T> decode(json: String): T = Serializer.moshi.adapter(T::class.java).fromJson(json)!!
        private fun money(amount: Long) = """{"amount_minor":$amount,"currency":"USD"}"""
        private fun balanceJson(requestable: Long = 1000, minimum: Long = 100) = """{"currency":"USD","pending":${money(200)},"available":${money(1000)},"in_payout":${money(0)},"paid":${money(0)},"reserve":${money(0)},"requestable":${money(requestable)},"minimum":${money(minimum)}}"""
        private fun balance(requestable: Long = 1000, minimum: Long = 100) = decode<EarningsBalance>(balanceJson(requestable, minimum))
        private fun entryJson(id: String) = """{"id":"$id","entry_id":"$USER","kind":"sale","state":"available","amount":${money(100)},"reference_type":"order","reference_id":"$USER","occurred_at":"2026-10-27T00:00:00Z"}"""
        private fun payoutJson(id: String) = """{"id":"$id","user_id":"$USER","amount":${money(1000)},"channel":"sandbox","state":"requested","reason_code":null,"approvals_required":1,"approvals":[],"requested_at":"2026-10-27T00:00:00Z","decided_at":null,"completed_at":null}"""
        private fun clientError(status: Int) = ClientException("synthetic", status, ClientError<Any>(body = "{}", statusCode = status))
    }
}
