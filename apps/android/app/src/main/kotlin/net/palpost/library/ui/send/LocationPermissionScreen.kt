package net.palpost.library.ui.send

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GpsFixed
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import net.palpost.library.R
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.tokens.VlSpace

/**
 * 13 · the location permission, once before the first send (ADR 0087 §1): why, before the system's dialog, which asks for
 * «while using the app» only (no background location is declared). «Not now» and a refusal both lead on to sending: the send
 * goes without `gps`, with the governorate and city as before.
 */
@Composable
fun LocationPermissionScreen(onDone: (granted: Boolean) -> Unit) {
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result -> onDone(result.values.any { it }) }
    Column(
        Modifier.fillMaxSize().background(Vl.colors.bgBase).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(VlSpace.s5),
        verticalArrangement = Arrangement.spacedBy(VlSpace.s5),
    ) {
        Spacer(Modifier.height(VlSpace.s10))
        Box(Modifier.size(VlSpace.s12 + VlSpace.s8).clip(CircleShape).background(Vl.colors.bgSunken).align(Alignment.CenterHorizontally), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Place, contentDescription = null, tint = Vl.colors.textBrand, modifier = Modifier.size(VlIcon.lg))
        }
        Text(stringResource(R.string.location_title), style = Vl.text.title, color = Vl.colors.textPrimary, modifier = Modifier.semantics { heading() })
        Text(stringResource(R.string.location_body), style = Vl.text.body, color = Vl.colors.textSecondary)
        VlCard(gap = VlSpace.s3) {
            Point(Icons.Outlined.Language, stringResource(R.string.location_point_place))
            HorizontalDivider(color = Vl.colors.borderLine)
            Point(Icons.Outlined.Shield, stringResource(R.string.location_point_hidden))
            HorizontalDivider(color = Vl.colors.borderLine)
            Point(Icons.Outlined.GpsFixed, stringResource(R.string.location_point_settings))
        }
        Spacer(Modifier.height(VlSpace.s8))
        PrimaryButton(stringResource(R.string.location_allow), { request.launch(DeviceLocation.PERMISSIONS) })
        GhostButton(stringResource(R.string.location_skip), { onDone(false) }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun Point(icon: ImageVector, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Icon(icon, contentDescription = null, tint = Vl.colors.textPrimary, modifier = Modifier.size(VlIcon.md))
        Text(text, style = Vl.text.body, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
    }
}
