package net.palpost.library.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import net.palpost.library.AppContainer
import net.palpost.library.PostHistoryApp
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.send.LocationConsent
import net.palpost.library.ui.earnings.ApiEarningsSource
import net.palpost.library.ui.earnings.EarningsScreen
import net.palpost.library.ui.earnings.EarningsViewModel
import net.palpost.library.ui.material.MyMaterialsScreen
import net.palpost.library.ui.notifications.NotificationsScreen
import net.palpost.library.ui.receipt.ReceiptScreen
import net.palpost.library.ui.receipt.ReceiptTarget
import net.palpost.library.ui.review.ReviewScreen
import net.palpost.library.ui.security.WipeDoneScreen
import net.palpost.library.ui.send.DeviceLocation
import net.palpost.library.ui.send.LocationPermissionScreen
import net.palpost.library.ui.send.ReplaceShotScreen
import net.palpost.library.ui.send.SendScreen
import net.palpost.library.ui.setup.TaskKillerSetupScreen
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.uploads.UploadsScreen

private enum class Screen { Home, FormPreview, Send, SetupThenSend, LocationThenSend, ReplaceShot, Uploads, Materials, Notifications, Review, Earnings, Receipt, Setup, Settings }

/** Screens a receipt never opens over: the send screen while it closes, and the steps leading to it (ADR 0088). */
private val NO_RECEIPT_OVER = setOf(Screen.Send, Screen.SetupThenSend, Screen.LocationThenSend, Screen.ReplaceShot, Screen.Receipt)

@Composable
fun AppRoot(container: AppContainer, openRequest: String? = null, onOpenHandled: () -> Unit = {}) {
    val authState by container.auth.state.collectAsStateWithLifecycle()
    val app = LocalContext.current.applicationContext as PostHistoryApp
    val lastWipe by app.lastWipe.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize().background(Vl.colors.bgBase)) {
        when (val state = authState) {
            is AuthState.SignedOut -> when {
                // SEC-01: after a revocation or an emergency wipe the reporter sees what was erased before any login form.
                state.reason == SignOutReason.SESSION_REVOKED -> WipeDoneScreen(lastWipe, revoked = true, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
                state.reason == SignOutReason.WIPED -> WipeDoneScreen(lastWipe, revoked = false, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
                else -> LoginScreen(container, sessionRevoked = false)
            }
            is AuthState.SignedIn -> SignedIn(container, app, state.userId, openRequest, onOpenHandled)
        }
    }
}

@Composable
private fun SignedIn(container: AppContainer, app: PostHistoryApp, userId: String, openRequest: String?, onOpenHandled: () -> Unit) {
    // Created on session restore too, before the earnings screen opens, so what it keeps is cleared on sign-out from home.
    val earnings: EarningsViewModel = viewModel(key = "earnings:$userId", factory = viewModelFactory {
        initializer { EarningsViewModel(ApiEarningsSource(container.authApi, container.earningsApi), createSavedStateHandle(), container.auth.state, userId) }
    })
    var screen by rememberSaveable { mutableStateOf(Screen.Home) }
    var draftId by rememberSaveable { mutableStateOf<String?>(null) }
    var replaceFor by rememberSaveable { mutableStateOf<String?>(null) }
    var receiptBatch by rememberSaveable { mutableStateOf<String?>(null) }
    var receiptTask by rememberSaveable { mutableStateOf<String?>(null) }
    var receiptBack by rememberSaveable { mutableStateOf(Screen.Home) }
    val location = DeviceLocation(app)

    fun afterSetup(): Screen = if (LocationConsent.shouldExplain(container.settings.locationAsked, location.granted())) Screen.LocationThenSend else Screen.Send
    fun startSend(draft: String? = null) {
        draftId = draft
        screen = if (!container.settings.taskKillerSetupDone) Screen.SetupThenSend else afterSetup()
    }
    fun openReceipt(target: ReceiptTarget, from: Screen) {
        receiptBatch = (target as? ReceiptTarget.Batch)?.batchId
        receiptTask = (target as? ReceiptTarget.Task)?.taskId
        receiptBack = if (from in NO_RECEIPT_OVER) Screen.Home else from
        screen = Screen.Receipt
    }

    // One receipt per send: the center follows the queue while the app is open and queues receipts; one shows at a time.
    LaunchedEffect(userId) { container.receipts.run() }
    val pending by container.receipts.pending.collectAsStateWithLifecycle()
    LaunchedEffect(pending, screen) {
        val next = pending.firstOrNull() ?: return@LaunchedEffect
        if (screen in NO_RECEIPT_OVER) return@LaunchedEffect
        container.receipts.shown(next)
        openReceipt(next, screen)
    }
    LaunchedEffect(openRequest) {
        if (openRequest == MainActivity.OPEN_NOTIFICATIONS) { screen = Screen.Notifications; onOpenHandled() }
    }
    BackHandler(enabled = screen != Screen.Home && screen != Screen.Send && screen != Screen.ReplaceShot) {
        screen = if (screen == Screen.Receipt) receiptBack else Screen.Home
    }
    when (screen) {
        Screen.Home -> HomeScreen(
            container,
            onSend = { startSend() },
            onOpenDraft = { startSend(it) },
            onUploads = { screen = Screen.Uploads },
            onMaterials = { screen = Screen.Materials },
            onNotifications = { screen = Screen.Notifications },
            onSettings = { screen = Screen.Settings },
            onReview = { screen = Screen.Review },
            onEarnings = { screen = Screen.Earnings },
        )
        Screen.SetupThenSend -> TaskKillerSetupScreen(container, onDone = { screen = afterSetup() }, onBack = { screen = Screen.Home })
        Screen.LocationThenSend -> LocationPermissionScreen(onDone = { _ -> container.settings.locationAsked = true; screen = Screen.Send })
        Screen.Send -> SendScreen(container, draftId, onClose = { screen = Screen.Home }, onSent = { screen = Screen.Uploads })
        Screen.ReplaceShot -> replaceFor?.let { m -> ReplaceShotScreen(container, m, onClose = { screen = Screen.Materials }, onQueued = { screen = Screen.Uploads }) }
        Screen.Uploads -> UploadsScreen(
            container, onBack = { screen = Screen.Home }, onReceipt = { openReceipt(ReceiptTarget.Task(it), Screen.Uploads) },
            onPickFileFor = { replaceFor = it; screen = Screen.ReplaceShot },
        )
        Screen.Receipt -> {
            val target = receiptBatch?.let { ReceiptTarget.Batch(it) } ?: receiptTask?.let { ReceiptTarget.Task(it) }
            if (target != null) ReceiptScreen(
                container, target, onDone = { screen = receiptBack }, onSendAnother = { startSend() }, onMyMaterials = { screen = Screen.Materials },
            )
        }
        Screen.Materials -> MyMaterialsScreen(
            container, onBack = { screen = Screen.Home }, onNewMaterial = { startSend() },
            onReceipt = { openReceipt(ReceiptTarget.Task(it), Screen.Materials) }, onReplacement = { replaceFor = it; screen = Screen.ReplaceShot },
        )
        Screen.Notifications -> NotificationsScreen(container, onBack = { screen = Screen.Home })
        Screen.Earnings -> EarningsScreen(earnings, onBack = { screen = Screen.Home })
        Screen.Review -> ReviewScreen(container, onBack = { screen = Screen.Home })
        Screen.Setup -> TaskKillerSetupScreen(container, onDone = { screen = Screen.Settings }, onBack = { screen = Screen.Settings })
        Screen.Settings -> SettingsScreen(container, onBack = { screen = Screen.Home }, onSetup = { screen = Screen.Setup }, onOpenForm = { screen = Screen.FormPreview })
        Screen.FormPreview -> FormPreviewScreen(container, onBack = { screen = Screen.Settings })
    }
}
