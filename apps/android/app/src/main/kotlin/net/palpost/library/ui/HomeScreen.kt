package net.palpost.library.ui

import android.app.Application
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Me
import net.palpost.library.api.models.RoleName
import net.palpost.library.data.DraftEntity
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.theme.ButtonSize
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.Signal
import net.palpost.library.ui.theme.StateBadge
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.ui.uploads.UploadsViewModel
import net.palpost.library.ui.uploads.stageWord
import java.time.LocalTime

data class HomeUiState(val me: Me? = null, val loading: Boolean = true, val error: String? = null)

class HomeViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state
    /** The signed-in account's drafts alone, by the queue's rule (ADR 0112, 0093): another's stay on the phone with nothing shown. */
    val drafts: StateFlow<List<DraftEntity>> = combine(container.database.drafts().observeAll(), container.scope) { rows, scope -> rows.filter { scope.owns(it.ownerAccount) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    /** «Latest sends»: the signed-in account's rows alone (ADR 0093). */
    val uploads: StateFlow<List<UploadTaskEntity>> = combine(container.database.uploads().observeAll(), container.scope) { rows, scope -> rows.filter { scope.owns(it.ownerAccount) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

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

/**
 * 03 · home: the greeting, notifications and settings, the big «Send from the field», drafts, the latest sends with their upload
 * state, and «My materials». The four former tabs became one screen that the destinations are pushed from (ADR 0088).
 */
@Composable
fun HomeScreen(
    container: AppContainer, onSend: () -> Unit, onOpenDraft: (String) -> Unit, onUploads: () -> Unit, onMaterials: () -> Unit,
    onNotifications: () -> Unit, onSettings: () -> Unit, onReview: () -> Unit, onEarnings: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as Application
    val vm: HomeViewModel = viewModel(factory = viewModelFactory { initializer { HomeViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    val drafts by vm.drafts.collectAsStateWithLifecycle()
    val uploads by vm.uploads.collectAsStateWithLifecycle()
    Column(
        Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(VlSpace.s5),
        verticalArrangement = Arrangement.spacedBy(VlSpace.s5),
    ) {
        Column(Modifier.widthIn(max = 600.dp).align(Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                val morning = LocalTime.now().hour < 12
                val name = s.me?.workName?.takeIf { it.isNotBlank() }
                val greeting = when {
                    name != null -> stringResource(if (morning) R.string.home_greeting_morning_named else R.string.home_greeting_evening_named, name)
                    else -> stringResource(if (morning) R.string.home_greeting_morning else R.string.home_greeting_evening)
                }
                Text(greeting, style = Vl.text.title, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f).semantics { heading() })
                VlIconButton(Icons.Outlined.Notifications, stringResource(R.string.home_notifications), onNotifications)
                VlIconButton(Icons.Outlined.Settings, stringResource(R.string.settings_title), onSettings)
            }
            s.error?.let { err ->
                Text(err, style = Vl.text.caption, color = Vl.colors.stateDanger)
                net.palpost.library.ui.theme.GhostButton(stringResource(R.string.action_retry), vm::load)
            }
            PrimaryButton(stringResource(R.string.home_send), onSend, size = ButtonSize.HERO)
            if (drafts.isNotEmpty()) {
                SectionTitle(stringResource(R.string.home_drafts))
                for (d in drafts) DraftRow(d) { onOpenDraft(d.id) }
            }
            val recent = uploads.sortedByDescending { it.createdAtEpochMs }.take(RECENT)
            if (recent.isNotEmpty()) {
                SectionTitle(stringResource(R.string.home_recent))
                for (t in recent) RecentRow(t, onUploads)
                OutlineButton(stringResource(R.string.home_uploads), onUploads, small = true)
            }
            OutlineButton(stringResource(R.string.home_materials), onMaterials)
            // The review inbox is offered to supervisors; the server still decides what each may see and do.
            if (s.me?.roles?.any { it.name.value == "supervisor" } == true) OutlineButton(stringResource(R.string.home_review), onReview)
            if (s.me?.roles?.any { it.name.value == "reporter" } == true) OutlineButton(stringResource(R.string.earnings_title), onEarnings)
        }
    }
}

private const val RECENT = 5

@Composable
private fun DraftRow(d: DraftEntity, onOpen: () -> Unit) {
    VlCard(modifier = Modifier.heightIn(min = MinTouchTarget).clickable(onClick = onOpen), gap = VlSpace.s2, padding = VlSpace.s4) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            StateBadge(stringResource(R.string.a2_draft_badge), Signal.MUTED)
            Text(d.title.ifBlank { stringResource(R.string.a2_draft_untitled) }, style = Vl.text.headline, color = Vl.colors.textPrimary, maxLines = 1)
        }
    }
}

/** A recent send's file: its title and its stage in a word and a colour (no thumbnail here, so nothing sensitive shows on the home screen). */
@Composable
private fun RecentRow(t: UploadTaskEntity, onOpen: () -> Unit) {
    val done = t.state in UploadsViewModel.DONE
    val failed = t.state == net.palpost.library.core.upload.UploadState.FAILED.name
    VlCard(modifier = Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).clickable(onClick = onOpen), gap = VlSpace.s1, padding = VlSpace.s4) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            Text(t.title.ifBlank { stringResource(R.string.a3_untitled) }, style = Vl.text.headline, color = Vl.colors.textPrimary, maxLines = 1, modifier = Modifier.weight(1f))
            StateBadge(stageWord(t), if (done) Signal.OK else if (failed) Signal.DANGER else Signal.BRAND)
        }
    }
}
