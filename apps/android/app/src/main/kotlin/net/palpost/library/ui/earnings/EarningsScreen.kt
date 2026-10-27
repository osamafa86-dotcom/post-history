package net.palpost.library.ui.earnings

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Currency
import net.palpost.library.api.models.PayableState
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.tokens.VlSpace
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EarningsScreen(container: AppContainer, userId: String, onBack: () -> Unit) {
    // المفتاح خاص بالمستدعي: لا تعاد حالة حساب سابق بعد تبديل الحساب في Activity نفسها.
    val vm: EarningsViewModel = viewModel(key = "earnings:$userId", factory = viewModelFactory {
        initializer { EarningsViewModel(ApiEarningsSource(container.authApi, container.earningsApi), createSavedStateHandle()) }
    })
    val s by vm.state.collectAsStateWithLifecycle()
    val locale = LocalConfiguration.current.locales[0]
    fun money(minor: Long, currency: Currency, signed: Boolean = false) = formatEarningsMoney(minor, currency, locale, signed)
    fun date(value: OffsetDateTime): String = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).withLocale(locale)
        .withZone(ZoneId.systemDefault()).format(value.toInstant())
    DisposableEffect(vm) { onDispose { vm.leave() } }
    LaunchedEffect(vm) { vm.refresh() }
    Scaffold(topBar = { TopAppBar(
        title = { Text(stringResource(R.string.earnings_title)) },
        navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        actions = { TextButton(onClick = vm::refresh, enabled = !s.loading && !s.requestBusy) { Text(stringResource(R.string.earnings_refresh)) } },
    ) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(VlSpace.s5), verticalArrangement = Arrangement.spacedBy(VlSpace.s4)) {
            item { VlCard { Text(stringResource(R.string.earnings_sandbox), style = Vl.text.bodyMd) } }
            if (s.loading) item { Text(stringResource(R.string.home_loading)) }
            s.failure?.let { failure -> item { Text(stringResource(when (failure) {
                EarningsFailure.NETWORK -> R.string.earnings_network
                EarningsFailure.CONFLICT -> R.string.earnings_conflict
                EarningsFailure.VALIDATION -> R.string.earnings_validation
                EarningsFailure.FORBIDDEN -> R.string.earnings_forbidden
            }), color = MaterialTheme.colorScheme.error) } }
            if (s.allowed) {
                if (s.requested) item { Text(stringResource(R.string.earnings_requested)) }
                if (s.pendingAttempt) item {
                    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                        Text(stringResource(R.string.earnings_pending_attempt))
                        OutlinedButton(onClick = vm::retryRequest, enabled = !s.requestBusy && !s.loading) { Text(stringResource(R.string.earnings_retry_request)) }
                    }
                }
                s.summary?.let { summary ->
                    item { Text(stringResource(R.string.earnings_as_of, date(summary.asOf))) }
                    if (summary.balances.isEmpty()) item { Text(stringResource(R.string.earnings_empty_balances)) }
                    items(summary.balances, key = { it.currency.value }) { balance ->
                        VlCard {
                            Text(balance.currency.value, style = Vl.text.bodyMd)
                            Text(stringResource(R.string.earnings_balance_pending, money(balance.pending.amountMinor, balance.currency)))
                            Text(stringResource(R.string.earnings_requestable, money(balance.requestable.amountMinor, balance.currency)))
                            Text(stringResource(R.string.earnings_minimum, money(balance.minimum.amountMinor, balance.currency)))
                            Button(onClick = { vm.request(balance) }, enabled = !s.requestBusy && !s.pendingAttempt && !s.loading && !s.requestNeedsRefresh && canRequest(balance)) {
                                Text(stringResource(R.string.earnings_request_sandbox))
                            }
                            if (!canRequest(balance)) Text(stringResource(R.string.earnings_below_minimum))
                        }
                    }
                }
                item { Text(stringResource(R.string.earnings_entries), style = Vl.text.bodyMd) }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                        Text(stringResource(R.string.earnings_currency))
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                            FilterChip(selected = s.currency == null, onClick = { vm.filter(null, s.payableState) }, label = { Text(stringResource(R.string.earnings_all)) })
                            Currency.values().forEach { currency -> FilterChip(selected = s.currency == currency, onClick = { vm.filter(currency, s.payableState) }, label = { Text(currency.value) }) }
                        }
                        Text(stringResource(R.string.earnings_state))
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                            FilterChip(selected = s.payableState == null, onClick = { vm.filter(s.currency, null) }, label = { Text(stringResource(R.string.earnings_all)) })
                            PayableState.values().forEach { state -> FilterChip(selected = s.payableState == state, onClick = { vm.filter(s.currency, state) }, label = { Text(stringResource(payableLabel(state.value))) }) }
                        }
                    }
                }
                items(s.entries, key = { "entry:${it.id}" }) { entry ->
                    VlCard {
                        Text(stringResource(entryLabel(entry.kind.value)))
                        Text(money(entry.amount.amountMinor, entry.amount.currency, signed = true), style = Vl.text.bodyMd)
                        Text(stringResource(payableLabel(entry.state.value)))
                        Text(date(entry.occurredAt))
                    }
                }
                if (s.entriesBusy) item { Text(stringResource(R.string.home_loading)) }
                else if (s.entries.isEmpty() && s.failure == null) item { Text(stringResource(R.string.earnings_empty_entries)) }
                if (s.entryCursor != null) item { OutlinedButton(onClick = { vm.loadEntries() }, enabled = !s.entriesBusy) { Text(stringResource(R.string.earnings_more_entries)) } }
                item { Text(stringResource(R.string.earnings_payouts), style = Vl.text.bodyMd) }
                items(s.payouts, key = { "payout:${it.id}" }) { payout ->
                    VlCard {
                        Text(money(payout.amount.amountMinor, payout.amount.currency), style = Vl.text.bodyMd)
                        Text(stringResource(payoutLabel(payout.state.value)))
                        Text(date(payout.requestedAt))
                        Text(stringResource(R.string.earnings_sandbox_short))
                    }
                }
                if (s.payoutsBusy) item { Text(stringResource(R.string.home_loading)) }
                else if (s.payouts.isEmpty() && s.failure == null) item { Text(stringResource(R.string.earnings_empty_payouts)) }
                if (s.payoutCursor != null) item { OutlinedButton(onClick = { vm.loadPayouts() }, enabled = !s.payoutsBusy) { Text(stringResource(R.string.earnings_more_payouts)) } }
            }
        }
    }
}

private fun payableLabel(value: String): Int = when (value) {
    "pending" -> R.string.earnings_pending
    "available" -> R.string.earnings_available
    "in_payout" -> R.string.earnings_in_payout
    "paid" -> R.string.earnings_paid
    else -> R.string.earnings_unknown
}
private fun entryLabel(value: String): Int = when (value) {
    "sale" -> R.string.earnings_sale
    "refund" -> R.string.earnings_refund
    "release" -> R.string.earnings_release
    "payout" -> R.string.earnings_payout
    "correction" -> R.string.earnings_correction
    else -> R.string.earnings_unknown
}
private fun payoutLabel(value: String): Int = when (value) {
    "requested" -> R.string.earnings_status_requested
    "approved" -> R.string.earnings_status_approved
    "processing" -> R.string.earnings_status_processing
    "paid" -> R.string.earnings_paid
    "failed" -> R.string.earnings_status_failed
    "rejected" -> R.string.earnings_status_rejected
    "cancelled" -> R.string.earnings_status_cancelled
    else -> R.string.earnings_unknown
}
