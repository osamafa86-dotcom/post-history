package net.palpost.library.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import net.palpost.library.AppContainer
import net.palpost.library.R

/**
 * The manufacturer-specific onboarding the field sheet `tools/acceptance/field/task-killers.md` relies on:
 * the reporter follows exactly these steps and nothing else before the 30-minute locked-screen test.
 */
@Composable
fun TaskKillerSetupScreen(container: AppContainer, onDone: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val vendor = remember { TaskKillerGuide.vendor() }
    val steps = remember { TaskKillerGuide.steps(context, vendor) }
    var batteryExempt by remember { mutableStateOf(TaskKillerGuide.isBatteryExempt(context)) }
    var notificationsGranted by remember { mutableStateOf(Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsGranted = it }

    // Re-read the exemption whenever the reporter comes back from the settings pages.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) batteryExempt = TaskKillerGuide.isBatteryExempt(context) }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.setup_title)) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) }) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp, vertical = 12.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.setup_intro, vendorLabel(vendor)), style = MaterialTheme.typography.bodyLarge)
            if (Build.VERSION.SDK_INT >= 33) {
                StepCard(
                    title = stringResource(R.string.setup_notifications_title), body = stringResource(R.string.setup_notifications_body),
                    status = if (notificationsGranted) stringResource(R.string.setup_status_done) else null,
                    actionLabel = if (notificationsGranted) null else stringResource(R.string.setup_allow),
                ) { notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
            }
            for ((index, step) in steps.withIndex()) {
                val status = when {
                    step.id == "battery" && batteryExempt -> stringResource(R.string.setup_status_done)
                    step.id == "battery" -> stringResource(R.string.setup_status_pending)
                    else -> null
                }
                StepCard(
                    title = "${index + 1}. " + stringResource(step.title), body = stringResource(step.body), status = status,
                    actionLabel = if (step.intents.isEmpty()) null else stringResource(R.string.setup_open_settings),
                ) { TaskKillerGuide.open(context, step) }
            }
            Text(stringResource(R.string.setup_footer), style = MaterialTheme.typography.bodySmall)
            Button(onClick = { container.settings.taskKillerSetupDone = true; onDone() }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(if (batteryExempt) R.string.setup_finish else R.string.setup_finish_anyway))
            }
        }
    }
}

@Composable
private fun StepCard(title: String, body: String, status: String?, actionLabel: String?, onAction: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (actionLabel != null) OutlinedButton(onClick = onAction) { Text(actionLabel) }
                if (status != null) Text(status, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
fun vendorLabel(vendor: Vendor): String = stringResource(
    when (vendor) {
        Vendor.XIAOMI -> R.string.vendor_xiaomi
        Vendor.SAMSUNG -> R.string.vendor_samsung
        Vendor.HUAWEI -> R.string.vendor_huawei
        Vendor.OPPO -> R.string.vendor_oppo
        Vendor.VIVO -> R.string.vendor_vivo
        Vendor.OTHER -> R.string.vendor_other
    },
)
