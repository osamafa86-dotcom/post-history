package net.palpost.library.ui.security

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import net.palpost.library.R
import net.palpost.library.core.security.WipeReport

/** Explicit confirmation: a checkbox stating what is lost, then a destructive button. No long-press tricks. */
@Composable
fun EmergencyWipeDialog(busy: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    var understood by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.wipe_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.wipe_body))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Checkbox(checked = understood, onCheckedChange = { understood = it }, enabled = !busy)
                    Text(stringResource(R.string.wipe_understand), modifier = Modifier.padding(top = 12.dp))
                }
            }
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = understood && !busy, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) {
                Text(stringResource(if (busy) R.string.wipe_in_progress else R.string.wipe_confirm))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.wipe_cancel)) } },
    )
}

/** Shown once after a wipe (emergency or after revocation). Names of stores only; no data. */
@Composable
fun WipeDoneScreen(report: WipeReport?, revoked: Boolean, onContinue: () -> Unit) {
    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(if (revoked) R.string.revoked_title else R.string.wipe_done_title), style = MaterialTheme.typography.headlineSmall)
            Text(stringResource(if (revoked) R.string.revoked_body else R.string.wipe_done_body))
            if (report != null) {
                Text(stringResource(R.string.wipe_report_wiped), style = MaterialTheme.typography.titleSmall)
                for (name in report.wiped) Text("• " + wipeTargetLabel(name))
                if (report.failed.isNotEmpty()) {
                    Text(stringResource(R.string.wipe_report_failed), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
                    for (name in report.failed) Text("• " + wipeTargetLabel(name), color = MaterialTheme.colorScheme.error)
                    Text(stringResource(R.string.wipe_report_failed_help), style = MaterialTheme.typography.bodySmall)
                }
            }
            Text(stringResource(R.string.wipe_originals_note), style = MaterialTheme.typography.bodySmall)
            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.wipe_continue)) }
        }
    }
}

@Composable
fun wipeTargetLabel(name: String): String = stringResource(
    when (name) {
        "transfers" -> R.string.wipe_target_transfers
        "session" -> R.string.wipe_target_session
        "upload_queue" -> R.string.wipe_target_upload_queue
        "file_grants" -> R.string.wipe_target_file_grants
        "preferences" -> R.string.wipe_target_preferences
        "caches_and_files" -> R.string.wipe_target_caches
        else -> R.string.wipe_target_other
    },
)
