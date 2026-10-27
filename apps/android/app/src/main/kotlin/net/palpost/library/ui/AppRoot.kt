package net.palpost.library.ui

import net.palpost.library.ui.earnings.EarningsScreen
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.platform.LocalContext
import net.palpost.library.AppContainer
import net.palpost.library.PostHistoryApp
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.ui.material.MyMaterialsScreen
import net.palpost.library.ui.material.NewMaterialScreen
import net.palpost.library.ui.security.WipeDoneScreen
import net.palpost.library.ui.setup.TaskKillerSetupScreen
import net.palpost.library.ui.notifications.NotificationsScreen
import net.palpost.library.ui.receipt.ReceiptScreen
import net.palpost.library.ui.review.ReviewScreen
import net.palpost.library.ui.uploads.UploadsScreen

private enum class Screen { Home, FormPreview, NewMaterial, Uploads, Materials, Notifications, Review, Earnings, Receipt, Setup, SetupThenNewMaterial }

@Composable
fun AppRoot(container: AppContainer, openRequest: String? = null, onOpenHandled: () -> Unit = {}) {
    val authState by container.auth.state.collectAsStateWithLifecycle()
    val app = LocalContext.current.applicationContext as PostHistoryApp
    val lastWipe by app.lastWipe.collectAsStateWithLifecycle()
    when (val state = authState) {
        is AuthState.SignedOut -> when {
            // SEC-01: after a revocation or an emergency wipe the reporter sees what was erased before any login form.
            state.reason == SignOutReason.SESSION_REVOKED -> WipeDoneScreen(lastWipe, revoked = true, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
            state.reason == SignOutReason.WIPED -> WipeDoneScreen(lastWipe, revoked = false, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
            else -> LoginScreen(container, sessionRevoked = false)
        }
        is AuthState.SignedIn -> {
            var screen by rememberSaveable { mutableStateOf(Screen.Home) }
            // Arguments of the reporter flow (#387): the receipt shown on A3, the draft or material A1 opens with.
            var receiptTaskId by rememberSaveable { mutableStateOf<String?>(null) }
            var draftId by rememberSaveable { mutableStateOf<String?>(null) }
            var attachTo by rememberSaveable { mutableStateOf<String?>(null) }
            var receiptBack by rememberSaveable { mutableStateOf(Screen.Uploads) }
            fun newMaterial(draft: String? = null, material: String? = null) {
                draftId = draft; attachTo = material
                screen = if (container.settings.taskKillerSetupDone) Screen.NewMaterial else Screen.SetupThenNewMaterial
            }
            fun receipt(taskId: String, from: Screen) { receiptTaskId = taskId; receiptBack = from; screen = Screen.Receipt }
            androidx.compose.runtime.LaunchedEffect(openRequest) {
                if (openRequest == MainActivity.OPEN_NOTIFICATIONS) { screen = Screen.Notifications; onOpenHandled() }
            }
            BackHandler(enabled = screen != Screen.Home) { screen = if (screen == Screen.Receipt) receiptBack else Screen.Home }
            when (screen) {
                Screen.Home -> HomeScreen(
                    container,
                    onOpenForm = { screen = Screen.FormPreview },
                    onNewMaterial = { newMaterial() },
                    onUploads = { screen = Screen.Uploads },
                    onMaterials = { screen = Screen.Materials },
                    onNotifications = { screen = Screen.Notifications },
                    onReview = { screen = Screen.Review },
                    onEarnings = { screen = Screen.Earnings },
                    onSetup = { screen = Screen.Setup },
                )
                Screen.FormPreview -> FormPreviewScreen(container, onBack = { screen = Screen.Home })
                Screen.NewMaterial -> NewMaterialScreen(container, draftId = draftId, attachToMaterialId = attachTo, onBack = { screen = Screen.Home }, onQueued = { screen = Screen.Uploads })
                Screen.Uploads -> UploadsScreen(
                    container, onBack = { screen = Screen.Home }, onReceipt = { receipt(it, Screen.Uploads) },
                    onNewMaterial = { newMaterial() }, onOpenDraft = { newMaterial(draft = it) },
                )
                Screen.Receipt -> receiptTaskId?.let { id -> ReceiptScreen(container, id, onBack = { screen = receiptBack }) }
                Screen.Materials -> MyMaterialsScreen(
                    container, onBack = { screen = Screen.Home }, onNewMaterial = { newMaterial() },
                    onReceipt = { receipt(it, Screen.Materials) }, onReplacement = { newMaterial(material = it) },
                )
                Screen.Notifications -> NotificationsScreen(container, onBack = { screen = Screen.Home })
                Screen.Earnings -> EarningsScreen(container, userId = state.userId, onBack = { screen = Screen.Home })
                Screen.Review -> ReviewScreen(container, onBack = { screen = Screen.Home })
                Screen.Setup -> TaskKillerSetupScreen(container, onDone = { screen = Screen.Home }, onBack = { screen = Screen.Home })
                Screen.SetupThenNewMaterial -> TaskKillerSetupScreen(container, onDone = { screen = Screen.NewMaterial }, onBack = { screen = Screen.Home })
            }
        }
    }
}
