package net.palpost.library.ui

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import net.palpost.library.AppContainer
import net.palpost.library.PostHistoryApp
import net.palpost.library.R
import net.palpost.library.ui.security.EmergencyWipeDialog
import net.palpost.library.api.models.Me
import net.palpost.library.api.models.RoleName

data class HomeUiState(val me: Me? = null, val loading: Boolean = true, val error: String? = null, val signingOut: Boolean = false, val wiping: Boolean = false)

class HomeViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                _state.update { it.copy(me = container.authApi.getMe(), loading = false) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = describeFailure(app, t)) }
            }
        }
    }

    fun logout(allSessions: Boolean) {
        if (_state.value.signingOut) return
        _state.update { it.copy(signingOut = true) }
        viewModelScope.launch { container.auth.logout(allSessions) }
    }

    /** SEC-01 emergency wipe: everything on the device, now; the server is not told (no network needed). */
    fun emergencyWipe() {
        if (_state.value.wiping) return
        _state.update { it.copy(wiping = true) }
        viewModelScope.launch { (app as PostHistoryApp).emergencyWipe() }
    }
}

/**
 * Keyed by the contract value, not the generated enum, so roles a newer contract adds (the buyer roles of v0.3,
 * which this staff app never receives) fall to a generic label instead of breaking the build.
 */
@Composable
fun roleLabel(name: RoleName): String = stringResource(
    when (name.value) {
        "system_admin" -> R.string.role_system_admin
        "editor_in_chief" -> R.string.role_editor_in_chief
        "supervisor" -> R.string.role_supervisor
        "producer" -> R.string.role_producer
        "finance" -> R.string.role_finance
        "reporter" -> R.string.role_reporter
        "rights_officer" -> R.string.role_rights_officer
        else -> R.string.role_other
    },
)

@Composable
fun HomeScreen(container: AppContainer, onOpenForm: () -> Unit, onNewMaterial: () -> Unit, onUploads: () -> Unit, onMaterials: () -> Unit, onSetup: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: HomeViewModel = viewModel(factory = viewModelFactory { initializer { HomeViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.home_title)) }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                s.loading -> Text(stringResource(R.string.home_loading))
                s.error != null -> {
                    Text(s.error!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = vm::load) { Text(stringResource(R.string.action_retry)) }
                }
                s.me != null -> {
                    val me = s.me!!
                    Text(stringResource(R.string.home_signed_in_as, me.email), style = MaterialTheme.typography.titleMedium)
                    val roles = me.roles.map { roleLabel(it.name) }
                    Text(if (roles.isEmpty()) stringResource(R.string.home_no_roles) else stringResource(R.string.home_roles, roles.joinToString("، ")))
                }
            }
            Button(onClick = onNewMaterial, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_new_material)) }
            OutlinedButton(onClick = onUploads, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_uploads)) }
            OutlinedButton(onClick = onMaterials, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_materials)) }
            OutlinedButton(onClick = onSetup, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_setup)) }
            TextButton(onClick = onOpenForm, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_open_form)) }
            OutlinedButton(onClick = { vm.logout(allSessions = false) }, enabled = !s.signingOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_logout)) }
            TextButton(onClick = { vm.logout(allSessions = true) }, enabled = !s.signingOut, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_logout_all)) }
            var confirmWipe by remember { mutableStateOf(false) }
            TextButton(onClick = { confirmWipe = true }, enabled = !s.wiping, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.home_emergency_wipe), color = MaterialTheme.colorScheme.error)
            }
            if (confirmWipe) EmergencyWipeDialog(busy = s.wiping, onConfirm = { vm.emergencyWipe() }, onDismiss = { confirmWipe = false })
        }
    }
}
