package net.palpost.library.ui.earnings

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.apis.EarningsApi
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.models.*
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.auth.AuthState
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

enum class EarningsFailure { NETWORK, CONFLICT, VALIDATION, FORBIDDEN }

/** حالة عرض فقط؛ أجسام الشبكة كلها من عميل العقد المولّد، ولا بيانات دفع أو حقول مشتري هنا. */
data class EarningsUiState(
    val allowed: Boolean = false,
    val loading: Boolean = true,
    val summary: EarningsSummary? = null,
    val entries: List<EarningsEntry> = emptyList(),
    val entryCursor: String? = null,
    val entriesBusy: Boolean = false,
    val payouts: List<PayoutRequest> = emptyList(),
    val payoutCursor: String? = null,
    val payoutsBusy: Boolean = false,
    val currency: Currency? = null,
    val payableState: PayableState? = null,
    val requestBusy: Boolean = false,
    val pendingAttempt: Boolean = false,
    val requested: Boolean = false,
    val requestNeedsRefresh: Boolean = false,
    val failure: EarningsFailure? = null,
)

interface EarningsSource {
    suspend fun me(): Me
    suspend fun summary(): EarningsSummary
    suspend fun entries(currency: Currency?, state: PayableState?, cursor: String?): EarningsEntryPage
    suspend fun payouts(cursor: String?): PayoutRequestPage
    suspend fun request(key: String, body: PayoutRequestCreate): PayoutRequest
}

class ApiEarningsSource(private val auth: AuthApi, private val api: EarningsApi) : EarningsSource {
    override suspend fun me() = auth.getMe()
    override suspend fun summary() = api.getMyEarnings()
    override suspend fun entries(currency: Currency?, state: PayableState?, cursor: String?) =
        api.listMyEarningsEntries(currency = currency, state = state, cursor = cursor, limit = 50)
    override suspend fun payouts(cursor: String?) = api.listMyPayoutRequests(cursor = cursor, limit = 50)
    override suspend fun request(key: String, body: PayoutRequestCreate) = api.createPayoutRequest(key, body)
}

/** لا حساب للرصيد محليًا؛ يبقى الخادم حكم الدور والحد والمتاح. محاولة الشبكة الملتبسة تحتفظ بجسمها ومفتاحها. */
class EarningsViewModel(
    private val source: EarningsSource,
    private val saved: SavedStateHandle,
    private val session: StateFlow<AuthState>,
    private val userId: String,
) : ViewModel() {
    private val _state = MutableStateFlow(EarningsUiState(pendingAttempt = saved.get<String>("payout_key") != null))
    val state: StateFlow<EarningsUiState> = _state
    private var entriesJob: Job? = null
    private var payoutsJob: Job? = null
    private var refreshJob: Job? = null
    private var requestJob: Job? = null
    private var entryGeneration = 0
    private var payoutGeneration = 0

    init {
        // يبقى المراقب حيًا عند مغادرة الشاشة؛ الخروج من الحساب يمحو المحاولة حتى من الشاشة الرئيسية.
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            session.collect { if (!hasSession()) endSession() }
        }
    }

    private fun hasSession() = (session.value as? AuthState.SignedIn)?.userId == userId

    private fun checkSession(): Boolean {
        if (hasSession()) return true
        endSession()
        return false
    }

    private fun endSession() {
        leave()
        clearAttempt()
        _state.value = EarningsUiState(loading = false)
    }

    fun refresh() {
        if (!checkSession()) return
        if (_state.value.requestBusy || refreshJob?.isActive == true) return
        entriesJob?.cancel(); payoutsJob?.cancel(); entryGeneration++; payoutGeneration++
        refreshJob = viewModelScope.launch {
            _state.update { it.copy(loading = true, allowed = false, summary = null, entries = emptyList(), payouts = emptyList(), entryCursor = null, payoutCursor = null, entriesBusy = false, payoutsBusy = false, failure = null) }
            try {
                if (source.me().roles.none { it.name.value == "reporter" }) {
                    _state.update { it.copy(loading = false, failure = EarningsFailure.FORBIDDEN) }; return@launch
                }
                val summary = source.summary()
                _state.update { it.copy(loading = false, allowed = true, summary = summary, requestNeedsRefresh = false) }
                loadEntries(reset = true); loadPayouts(reset = true)
            } catch (e: Exception) { fail(e); _state.update { it.copy(loading = false) } }
        }
    }

    fun filter(currency: Currency?, state: PayableState?) {
        if (!checkSession()) return
        if (!_state.value.allowed || (_state.value.currency == currency && _state.value.payableState == state)) return
        entriesJob?.cancel(); entryGeneration++
        _state.update { it.copy(currency = currency, payableState = state, entriesBusy = false, entries = emptyList(), entryCursor = null, failure = null) }
        loadEntries(reset = true)
    }

    fun loadEntries(reset: Boolean = false) {
        if (!checkSession()) return
        val s = _state.value
        if (!s.allowed || s.entriesBusy || (!reset && s.entryCursor == null)) return
        val generation = ++entryGeneration
        _state.update { it.copy(entriesBusy = true, failure = null) }
        entriesJob = viewModelScope.launch {
            try {
                val page = source.entries(s.currency, s.payableState, if (reset) null else s.entryCursor)
                if (generation == entryGeneration) _state.update { it.copy(entries = ((if (reset) emptyList() else it.entries) + page.items).distinctBy { e -> e.id }, entryCursor = page.nextCursor) }
            } catch (e: Exception) { if (generation == entryGeneration) fail(e) }
            finally { if (generation == entryGeneration) _state.update { it.copy(entriesBusy = false) } }
        }
    }

    fun loadPayouts(reset: Boolean = false) {
        if (!checkSession()) return
        val s = _state.value
        if (!s.allowed || s.payoutsBusy || (!reset && s.payoutCursor == null)) return
        val generation = ++payoutGeneration
        _state.update { it.copy(payoutsBusy = true, failure = null) }
        payoutsJob = viewModelScope.launch {
            try {
                val page = source.payouts(if (reset) null else s.payoutCursor)
                if (generation == payoutGeneration) _state.update { it.copy(payouts = ((if (reset) emptyList() else it.payouts) + page.items).distinctBy { p -> p.id }, payoutCursor = page.nextCursor) }
            } catch (e: Exception) { if (generation == payoutGeneration) fail(e) }
            finally { if (generation == payoutGeneration) _state.update { it.copy(payoutsBusy = false) } }
        }
    }

    fun request(balance: EarningsBalance) {
        if (!checkSession()) return
        val s = _state.value
        if (!s.allowed || s.loading || s.requestBusy || s.pendingAttempt || s.requestNeedsRefresh || !canRequest(balance)) return
        // الجسم والمفتاح يُحفظان مع حالة الشاشة، قبل بدء الطلب، لإعادة المحاولة بعد إعادة الإنشاء أيضًا.
        saved["payout_key"] = IdempotencyKey.generate()
        saved["payout_amount"] = balance.requestable.amountMinor
        saved["payout_currency"] = balance.currency.value
        _state.update { it.copy(pendingAttempt = true) }
        retryRequest()
    }

    fun retryRequest() {
        if (!checkSession()) return
        val s = _state.value
        val key = saved.get<String>("payout_key") ?: return
        val minor = saved.get<Long>("payout_amount") ?: return
        val currency = Currency.values().find { it.value == saved.get<String>("payout_currency") } ?: return
        if (!s.allowed || s.requestBusy || s.loading) return
        val body = PayoutRequestCreate(amount = Money(amountMinor = minor, currency = currency), channel = PayoutChannel.sandbox)
        _state.update { it.copy(requestBusy = true, failure = null, requested = false) }
        requestJob = viewModelScope.launch {
            try {
                source.request(key, body)
                clearAttempt()
                // لا خصم تفاؤلي ولا افتراض تسديد: إعادة قراءة الأرصدة والحالات من الخادم.
                _state.update { it.copy(requested = true, requestNeedsRefresh = true) }
                val summary = source.summary()
                _state.update { it.copy(summary = summary, requestNeedsRefresh = false) }
                payoutsJob?.cancel(); payoutGeneration++
                _state.update { it.copy(payoutsBusy = false) }
                loadPayouts(reset = true)
            } catch (e: Exception) {
                // 422 رفض قطعي بلا أثر؛ 409 أو انقطاع الشبكة قد يكونان طلبًا جارياً، فتبقى المحاولة نفسها.
                if (e is ClientException && e.statusCode == 422) {
                    clearAttempt(); _state.update { it.copy(requestNeedsRefresh = true) }
                }
                fail(e)
            } finally { _state.update { it.copy(requestBusy = false) } }
        }
    }

    /** ترك الشاشة يوقف القراءة والطلب الجاري، مع بقاء مفتاح محاولة لم تتأكد نتيجتها. */
    fun leave() {
        refreshJob?.cancel(); entriesJob?.cancel(); payoutsJob?.cancel(); requestJob?.cancel()
        entryGeneration++; payoutGeneration++
        _state.update { it.copy(allowed = false, summary = null, entries = emptyList(), payouts = emptyList(), entriesBusy = false, payoutsBusy = false, requestBusy = false) }
    }

    private fun clearAttempt() {
        saved.remove<String>("payout_key"); saved.remove<Long>("payout_amount"); saved.remove<String>("payout_currency")
        _state.update { it.copy(pendingAttempt = false) }
    }

    private fun fail(e: Exception) {
        if (e is CancellationException) throw e
        val failure = when ((e as? ClientException)?.statusCode) {
            401, 403 -> EarningsFailure.FORBIDDEN
            409 -> EarningsFailure.CONFLICT
            422 -> EarningsFailure.VALIDATION
            else -> EarningsFailure.NETWORK
        }
        _state.update { if (failure == EarningsFailure.FORBIDDEN) it.copy(allowed = false, summary = null, entries = emptyList(), payouts = emptyList(), failure = failure) else it.copy(failure = failure) }
    }
}

fun canRequest(balance: EarningsBalance): Boolean = balance.requestable.currency == balance.currency &&
    balance.minimum.currency == balance.currency && balance.requestable.amountMinor > 0 && balance.requestable.amountMinor >= balance.minimum.amountMinor

/** العملتان في العقد من منزلتين؛ BigDecimal يتجنب التقريب الثنائي ويحفظ إشارة سطر القيد. */
fun formatEarningsMoney(minor: Long, currency: Currency, locale: Locale, signed: Boolean = false): String {
    val formatter = NumberFormat.getCurrencyInstance(locale).apply { this.currency = java.util.Currency.getInstance(currency.value); minimumFractionDigits = 2; maximumFractionDigits = 2 }
    return (if (signed && minor > 0) "+" else "") + formatter.format(BigDecimal.valueOf(minor, 2))
}
