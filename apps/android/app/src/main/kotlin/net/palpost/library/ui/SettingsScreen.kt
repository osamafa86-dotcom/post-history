package net.palpost.library.ui

import android.app.Application
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.PostHistoryApp
import net.palpost.library.R
import net.palpost.library.api.models.DisplayName
import net.palpost.library.api.models.Me
import net.palpost.library.push.Push
import net.palpost.library.security.SignOut
import net.palpost.library.ui.security.EmergencyWipeDialog
import net.palpost.library.ui.send.displayModeText
import net.palpost.library.ui.theme.FieldLabel
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlChip
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.vlFieldColors
import net.palpost.library.ui.theme.tokens.VlSpace

class SettingsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    data class UiState(
        val me: Me? = null,
        val displayMode: String = "real_name",
        val pseudonym: String = "",
        val wifiOnly: Boolean = false,
        val signingOut: Boolean = false,
        val wiping: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState(wifiOnly = container.settings.uploadOverWifiOnly))
    val state: StateFlow<UiState> = _state

    init {
        viewModelScope.launch {
            val memory = withContext(Dispatchers.IO) { container.reporterMemory.load() }
            _state.update { it.copy(displayMode = memory.effectiveDisplayMode, pseudonym = memory.pseudonym) }
            runCatching { container.authApi.getMe() }.onSuccess { me -> _state.update { it.copy(me = me) } }
        }
    }

    /** The default display name of new sends (`real_name` until changed); each send can still change it under «More». */
    fun setDisplayMode(mode: String) {
        _state.update { it.copy(displayMode = mode) }
        viewModelScope.launch(Dispatchers.IO) { container.reporterMemory.update { it.copy(displayMode = mode) } }
    }

    fun setPseudonym(v: String) {
        _state.update { it.copy(pseudonym = v) }
        viewModelScope.launch(Dispatchers.IO) { container.reporterMemory.update { it.copy(pseudonym = v.trim()) } }
    }

    fun toggleWifiOnly() {
        val now = !container.settings.uploadOverWifiOnly
        container.settings.uploadOverWifiOnly = now
        _state.update { it.copy(wifiOnly = now) }
        viewModelScope.launch { net.palpost.library.upload.UploadScheduler.resumePending(app) }
    }

    /**
     * The signed-in account's originals not finished yet (ADR 0093 §6): they carry on after sign-out and stay hidden with their
     * receipt until this account signs in again, so sign-out says so first.
     */
    suspend fun pendingAtLogout(): Int = withContext(Dispatchers.IO) {
        container.scope.value.pending(container.database.uploads().all(), { it.ownerAccount }) {
            it.kind == "original" && !net.palpost.library.core.upload.UploadState.valueOf(it.state).terminal
        }
    }

    /**
     * Sign-out: shown notifications, then what the app remembers for this reporter (place, tags, the sends file; the receipts on
     * screen or waiting go back to waiting for their owner), then the push registration and the session. The upload queue
     * carries on in its owners' names (ADR 0093).
     */
    fun logout(allSessions: Boolean) {
        if (_state.value.signingOut) return
        _state.update { it.copy(signingOut = true) }
        viewModelScope.launch {
            SignOut(
                cancelShownNotifications = { androidx.core.app.NotificationManagerCompat.from(app).cancelAll() },
                unregisterPush = { Push.unregister(container) },
                endSession = { all -> container.auth.logout(all) },
                forgetReporter = {
                    container.receipts.signedOut()
                    withContext(Dispatchers.IO) { container.reporterMemory.clear(); container.sendBatches.forgetAll(); container.database.drafts().forgetAllGps() }
                },
            ).run(allSessions)
        }
    }

    /** SEC-01 emergency wipe: everything on the device, now; the server is not told (no network needed). */
    fun emergencyWipe() {
        if (_state.value.wiping) return
        _state.update { it.copy(wiping = true) }
        viewModelScope.launch { (app as PostHistoryApp).emergencyWipe() }
    }
}

/** 12 · settings: the account, the default display name, the upload, the task-killer setup, the session and the emergency wipe. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(container: AppContainer, onBack: () -> Unit, onSetup: () -> Unit, onOpenForm: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: SettingsViewModel = viewModel(factory = viewModelFactory { initializer { SettingsViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    var confirmWipe by remember { mutableStateOf(false) }
    if (confirmWipe) EmergencyWipeDialog(busy = s.wiping, onConfirm = { vm.emergencyWipe() }, onDismiss = { confirmWipe = false })
    var confirmLogoutAll by remember { mutableStateOf(false) }
    if (confirmLogoutAll) AlertDialog(
        onDismissRequest = { confirmLogoutAll = false },
        title = { Text(stringResource(R.string.home_logout_all), style = Vl.text.headline) },
        text = { Text(stringResource(R.string.settings_logout_all_body), style = Vl.text.body) },
        confirmButton = { GhostButton(stringResource(R.string.home_logout_all), { confirmLogoutAll = false; vm.logout(allSessions = true) }, destructive = true) },
        dismissButton = { GhostButton(stringResource(R.string.review_cancel), { confirmLogoutAll = false }) },
    )
    var pendingLogout by remember { mutableStateOf(0) }
    if (pendingLogout > 0) AlertDialog(
        onDismissRequest = { pendingLogout = 0 },
        title = { Text(stringResource(R.string.settings_logout_pending_title), style = Vl.text.headline) },
        text = { Text(pluralStringResource(R.plurals.settings_logout_pending_body, pendingLogout, pendingLogout), style = Vl.text.body) },
        confirmButton = { GhostButton(stringResource(R.string.settings_logout_pending_confirm), { pendingLogout = 0; vm.logout(allSessions = false) }) },
        dismissButton = { GhostButton(stringResource(R.string.review_cancel), { pendingLogout = 0 }) },
    )
    val scope = rememberCoroutineScope()
    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.action_back), onBack, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(VlSpace.s5), verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
            SectionTitle(stringResource(R.string.settings_account))
            VlCard(gap = VlSpace.s2) {
                s.me?.let { me ->
                    me.workName?.takeIf { it.isNotBlank() }?.let { Text(it, style = Vl.text.headline, color = Vl.colors.textPrimary) }
                    Text(me.email, style = Vl.text.body, color = Vl.colors.textSecondary)
                    val roles = me.roles.map { roleLabel(it.name) }
                    Text(if (roles.isEmpty()) stringResource(R.string.home_no_roles) else stringResource(R.string.home_roles, roles.joinToString("، ")), style = Vl.text.caption, color = Vl.colors.textSecondary)
                } ?: Text(stringResource(R.string.home_loading), style = Vl.text.body, color = Vl.colors.textSecondary)
            }
            FieldLabel(stringResource(R.string.settings_display_name))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                for (m in DisplayName.Mode.entries) VlChip(displayModeText(m), s.displayMode == m.value, { vm.setDisplayMode(m.value) })
            }
            if (s.displayMode == "pseudonym") OutlinedTextField(
                value = s.pseudonym, onValueChange = vm::setPseudonym, label = { Text(stringResource(R.string.material_pseudonym)) }, singleLine = true,
                textStyle = Vl.text.body, colors = vlFieldColors(), modifier = Modifier.fillMaxWidth(),
            )
            SectionTitle(stringResource(R.string.settings_upload))
            Row(
                Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).clickable(onClick = vm::toggleWifiOnly).semantics(mergeDescendants = true) { role = Role.Switch },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.settings_wifi_only), style = Vl.text.body, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
                Switch(s.wifiOnly, { vm.toggleWifiOnly() }, colors = SwitchDefaults.colors(checkedTrackColor = Vl.colors.actionPrimary, checkedThumbColor = Vl.colors.textOnBrand))
            }
            OutlineButton(stringResource(R.string.home_setup), onSetup)
            GhostButton(stringResource(R.string.home_open_form), onOpenForm)
            SectionTitle(stringResource(R.string.settings_session))
            OutlineButton(stringResource(R.string.home_logout), {
                scope.launch { vm.pendingAtLogout().let { n -> if (n > 0) pendingLogout = n else vm.logout(allSessions = false) } }
            }, enabled = !s.signingOut)
            GhostButton(stringResource(R.string.home_logout_all), { confirmLogoutAll = true }, enabled = !s.signingOut, destructive = true)
            GhostButton(stringResource(R.string.home_emergency_wipe), { confirmWipe = true }, enabled = !s.wiping, destructive = true)
        }
    }
}
