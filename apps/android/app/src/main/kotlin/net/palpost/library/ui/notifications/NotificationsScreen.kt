package net.palpost.library.ui.notifications

import android.app.Application
import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Notification
import net.palpost.library.api.models.Priority
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.ui.describeFailure

/** The user's notifications (`GET /notifications`): read on open, acknowledgement where the newsroom asks for it. */
class NotificationsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    data class UiState(val items: List<Notification> = emptyList(), val nextCursor: String? = null, val unread: Long = 0, val loading: Boolean = false, val error: String? = null)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun refresh() = load(null)
    fun more() { _state.value.nextCursor?.let { load(it) } }

    private fun load(cursor: String?) {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val page = container.notificationsApi.listNotifications(cursor = cursor, limit = 50)
                _state.update { s -> s.copy(items = if (cursor == null) page.items else s.items + page.items, nextCursor = page.nextCursor, unread = page.unreadCount, loading = false) }
                page.items.filter { it.readAt == null }.forEach { n -> runCatching { container.notificationsApi.readNotification(IdempotencyKey.generate(), n.id) } }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = describeFailure(app, e)) }
            }
        }
    }

    fun acknowledge(n: Notification) = viewModelScope.launch {
        try {
            container.notificationsApi.ackNotification(IdempotencyKey.generate(), n.id)
            _state.update { s -> s.copy(items = s.items.map { if (it.id == n.id) it.copy(state = Notification.State.acknowledged, acknowledgedAt = java.time.OffsetDateTime.now()) else it }) }
        } catch (e: Exception) {
            _state.update { it.copy(error = describeFailure(app, e)) }
        }
    }
}

@Composable
fun NotificationsScreen(container: AppContainer, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: NotificationsViewModel = viewModel(factory = viewModelFactory { initializer { NotificationsViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.refresh() }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(stringResource(R.string.notifications_title)) },
            navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
            actions = { TextButton(onClick = vm::refresh, enabled = !s.loading) { Text(stringResource(R.string.notifications_refresh)) } },
        )
    }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            s.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (s.items.isEmpty() && !s.loading && s.error == null) item { Text(stringResource(R.string.notifications_empty)) }
            items(s.items, key = { it.id }) { n ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val urgent = n.priority == Priority.urgent
                        Text(n.title ?: stringResource(R.string.notif_newsroom_title), style = MaterialTheme.typography.titleMedium, color = if (urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                        Text(DateUtils.getRelativeTimeSpanString(n.createdAt.toInstant().toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString(), style = MaterialTheme.typography.bodySmall)
                        when {
                            n.state == Notification.State.acknowledged -> Text(stringResource(R.string.notifications_acknowledged), style = MaterialTheme.typography.bodySmall)
                            urgent || n.escalationLevel != null -> OutlinedButton(onClick = { vm.acknowledge(n) }) { Text(stringResource(R.string.notifications_ack)) }
                        }
                    }
                }
            }
            if (s.loading) item { Text(stringResource(R.string.notifications_loading)) }
            else if (s.nextCursor != null) item { OutlinedButton(onClick = vm::more, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.notifications_more)) } }
        }
    }
}
