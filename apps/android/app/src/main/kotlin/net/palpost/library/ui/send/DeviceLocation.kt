package net.palpost.library.ui.send

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import net.palpost.library.core.send.GpsFix
import kotlin.coroutines.resume

/**
 * The filming location on the phone (ADR 0087): with the «while in use» permission only (no background location is declared),
 * read when the send screen opens and again on «Send». The fix goes to memory and into `POST /materials`, never to a log, a
 * notification, a preview or the screen. Declined permission or no fix: the send goes without `gps`.
 */
class DeviceLocation(private val context: Context) {
    private val manager: LocationManager? = context.getSystemService(LocationManager::class.java)

    fun granted(): Boolean = PERMISSIONS.any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

    /** A current fix within [timeoutMs], else the freshest the system already holds; null without permission or provider. */
    @SuppressLint("MissingPermission")
    suspend fun current(timeoutMs: Long = 4_000): GpsFix? {
        val lm = manager ?: return null
        if (!granted()) return null
        val providers = runCatching { lm.getProviders(true) }.getOrDefault(emptyList())
        val provider = PREFERRED.firstOrNull { it in providers } ?: return lastKnown(lm, providers)
        val fresh = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine<Location?> { cont ->
                val signal = CancellationSignal()
                cont.invokeOnCancellation { signal.cancel() }
                runCatching { lm.getCurrentLocation(provider, signal, ContextCompat.getMainExecutor(context)) { loc -> if (cont.isActive) cont.resume(loc) } }
                    .onFailure { if (cont.isActive) cont.resume(null) }
            }
        } else null
        return fresh?.toFix() ?: lastKnown(lm, providers)
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown(lm: LocationManager, providers: List<String>): GpsFix? =
        providers.mapNotNull { p -> runCatching { lm.getLastKnownLocation(p) }.getOrNull() }.maxByOrNull { it.time }?.toFix()

    private fun Location.toFix(): GpsFix = GpsFix(latitude, longitude, if (hasAccuracy()) accuracy.toDouble() else null, time)

    companion object {
        /** Precise and approximate together, as Android 12+ requires; never `ACCESS_BACKGROUND_LOCATION`. */
        val PERMISSIONS = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        private val PREFERRED = listOf("fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    }
}
