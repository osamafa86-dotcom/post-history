package net.palpost.library.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.PostHistoryApp
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.notifications.NotificationLink
import net.palpost.library.core.notifications.NotificationLinks
import net.palpost.library.core.notifications.NotificationTarget
import net.palpost.library.core.send.LocationConsent
import net.palpost.library.ui.earnings.ApiEarningsSource
import net.palpost.library.ui.earnings.EarningsScreen
import net.palpost.library.ui.earnings.EarningsViewModel
import net.palpost.library.ui.material.MaterialDetailScreen
import net.palpost.library.ui.material.MyMaterialsScreen
import net.palpost.library.ui.material.localRecords
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

private enum class Screen { Home, FormPreview, Send, SetupThenSend, LocationThenSend, ReplaceShot, Uploads, Materials, MaterialDetail, Notifications, Review, Earnings, Receipt, Setup, Settings }

/** Screens a receipt never opens over: the send screen while it closes, and the steps leading to it (ADR 0088). */
private val NO_RECEIPT_OVER = setOf(Screen.Send, Screen.SetupThenSend, Screen.LocationThenSend, Screen.ReplaceShot, Screen.Receipt)

/**
 * [link] is a notification's tap waiting to be followed (ADR 0106). Signed out, the login screen shows and the tap waits; after
 * the sign-in it is followed for the account it was shown to, or dropped for another one. A revocation or a wipe drops it.
 */
@Composable
fun AppRoot(container: AppContainer, link: NotificationLink? = null, onLinkHandled: () -> Unit = {}) {
    val authState by container.auth.state.collectAsStateWithLifecycle()
    val app = LocalContext.current.applicationContext as PostHistoryApp
    val lastWipe by app.lastWipe.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize().background(Vl.colors.bgBase)) {
        when (val state = authState) {
            is AuthState.SignedOut -> {
                val erased = state.reason == SignOutReason.SESSION_REVOKED || state.reason == SignOutReason.WIPED
                LaunchedEffect(erased, link) { if (erased && link != null) onLinkHandled() }
                when {
                    // SEC-01: after a revocation or an emergency wipe the reporter sees what was erased before any login form.
                    state.reason == SignOutReason.SESSION_REVOKED -> WipeDoneScreen(lastWipe, revoked = true, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
                    state.reason == SignOutReason.WIPED -> WipeDoneScreen(lastWipe, revoked = false, onContinue = { app.acknowledgeWipe(); container.auth.forgetSession(SignOutReason.USER) })
                    else -> LoginScreen(container, sessionRevoked = false)
                }
            }
            is AuthState.SignedIn -> SignedIn(container, app, state.userId, link, onLinkHandled)
        }
    }
}

@Composable
private fun SignedIn(container: AppContainer, app: PostHistoryApp, userId: String, link: NotificationLink?, onLinkHandled: () -> Unit) {
    // Created on session restore too, before the earnings screen opens, so what it keeps is cleared on sign-out from home.
    val earnings: EarningsViewModel = viewModel(key = "earnings:$userId", factory = viewModelFactory {
        initializer { EarningsViewModel(ApiEarningsSource(container.authApi, container.earningsApi), createSavedStateHandle(), container.auth.state, userId) }
    })
    var screen by rememberSaveable { mutableStateOf(Screen.Home) }
    var draftId by rememberSaveable { mutableStateOf<String?>(null) }
    var replaceFor by rememberSaveable { mutableStateOf<String?>(null) }
    var replaceBack by rememberSaveable { mutableStateOf(Screen.Materials) }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var detailBack by rememberSaveable { mutableStateOf(Screen.Materials) }
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
    fun openMaterial(materialId: String, from: Screen) { detailId = materialId; detailBack = from; screen = Screen.MaterialDetail }

    /**
     * A notification's target (ADR 0106): the list; the material's detail; or the receipt of the signed-in account's own original
     * of that material that the server verified, and the detail when this phone has none. Back returns to [from].
     */
    suspend fun follow(target: NotificationTarget, from: Screen) {
        when (target) {
            NotificationTarget.Inbox -> screen = Screen.Notifications
            is NotificationTarget.Material -> openMaterial(target.materialId, from)
            is NotificationTarget.Receipt -> {
                val rows = runCatching { container.database.uploads().forMaterials(listOf(target.materialId)) }.getOrDefault(emptyList())
                val row = NotificationLinks.receiptRecord(target.materialId, localRecords(rows, container.scope.value))
                if (row != null) openReceipt(ReceiptTarget.Task(row.id), from) else openMaterial(target.materialId, from)
            }
        }
    }

    // A tap on a push: followed once the signed-in account is known, for that account alone; the screen opens over home. Like a
    // receipt, it never opens over the send screen and its steps or over a receipt: it waits until the reporter leaves them.
    val accountScope by container.scope.collectAsStateWithLifecycle()
    LaunchedEffect(link, accountScope, screen in NO_RECEIPT_OVER) {
        val l = link ?: return@LaunchedEffect
        if (screen in NO_RECEIPT_OVER) return@LaunchedEffect
        when (val step = NotificationLinks.step(l, accountScope)) {
            NotificationLinks.Step.Wait -> Unit
            NotificationLinks.Step.Drop -> onLinkHandled()
            is NotificationLinks.Step.Open -> { follow(step.target, Screen.Home); onLinkHandled() }
        }
    }
    val uiScope = rememberCoroutineScope()
    fun replace(materialId: String, from: Screen) { replaceFor = materialId; replaceBack = from; screen = Screen.ReplaceShot }
    fun closeReceipt() { container.receipts.closed(); screen = receiptBack }
    BackHandler(enabled = screen != Screen.Home && screen != Screen.Send && screen != Screen.ReplaceShot) {
        when (screen) {
            Screen.Receipt -> closeReceipt()
            Screen.MaterialDetail -> screen = detailBack
            else -> screen = Screen.Home
        }
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
        Screen.ReplaceShot -> replaceFor?.let { m -> ReplaceShotScreen(container, m, onClose = { screen = replaceBack }, onQueued = { screen = Screen.Uploads }) }
        Screen.Uploads -> UploadsScreen(
            container, onBack = { screen = Screen.Home }, onReceipt = { openReceipt(ReceiptTarget.Task(it), Screen.Uploads) },
            onPickFileFor = { replace(it, Screen.Materials) },
        )
        Screen.Receipt -> {
            val target = receiptBatch?.let { ReceiptTarget.Batch(it) } ?: receiptTask?.let { ReceiptTarget.Task(it) }
            if (target != null) ReceiptScreen(
                container, target, onDone = { closeReceipt() }, onSendAnother = { container.receipts.closed(); startSend() },
                onMyMaterials = { container.receipts.closed(); screen = Screen.Materials },
            )
        }
        Screen.Materials -> MyMaterialsScreen(
            container, onBack = { screen = Screen.Home }, onNewMaterial = { startSend() },
            onOpen = { openMaterial(it, Screen.Materials) },
        )
        Screen.MaterialDetail -> detailId?.let { id ->
            MaterialDetailScreen(
                container, id, onBack = { screen = detailBack },
                onReceipt = { openReceipt(ReceiptTarget.Task(it), Screen.MaterialDetail) }, onReplacement = { replace(it, Screen.MaterialDetail) },
            )
        }
        Screen.Notifications -> NotificationsScreen(
            container, onBack = { screen = Screen.Home },
            onOpen = { target -> uiScope.launch { follow(target, Screen.Notifications) } },
        )
        Screen.Earnings -> EarningsScreen(earnings, onBack = { screen = Screen.Home })
        Screen.Review -> ReviewScreen(container, onBack = { screen = Screen.Home })
        Screen.Setup -> TaskKillerSetupScreen(container, onDone = { screen = Screen.Settings }, onBack = { screen = Screen.Settings })
        Screen.Settings -> SettingsScreen(container, onBack = { screen = Screen.Home }, onSetup = { screen = Screen.Setup }, onOpenForm = { screen = Screen.FormPreview })
        Screen.FormPreview -> FormPreviewScreen(container, onBack = { screen = Screen.Settings })
    }
}
