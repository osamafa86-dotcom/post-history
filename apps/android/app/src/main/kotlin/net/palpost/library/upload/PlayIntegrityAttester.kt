package net.palpost.library.upload

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityToken
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.palpost.library.core.upload.AttestationException
import net.palpost.library.core.upload.DeviceAttester
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Play Integrity standard requests (ADR 0011): the provider is prepared once and reused; each request carries the
 * session-bound request hash, so a verdict cannot serve another session. The verdict is decoded by the server only.
 * Nothing about the device leaves the phone beyond what Google puts in the verdict; nothing is logged.
 */
class PlayIntegrityAttester(context: Context, private val cloudProjectNumber: Long) : DeviceAttester {
    private val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
    private val lock = Mutex()
    private var provider: StandardIntegrityTokenProvider? = null

    override suspend fun attest(requestHash: String): String {
        val p = provider() 
        return try {
            p.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()).await().token()
        } catch (e: StandardIntegrityException) {
            if (e.errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) lock.withLock { provider = null }
            throw classify(e)
        }
    }

    private suspend fun provider(): StandardIntegrityTokenProvider = lock.withLock {
        provider ?: try {
            manager.prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProjectNumber).build()).await()
        } catch (e: StandardIntegrityException) {
            throw classify(e)
        }.also { provider = it }
    }

    private fun classify(e: StandardIntegrityException) = AttestationException(
        transient = e.errorCode in TRANSIENT,
        message = "play integrity error ${e.errorCode}",
        cause = e,
    )

    private companion object {
        /** Worth another attempt later; every other code means this install cannot attest (no Play, side-loaded…). */
        val TRANSIENT = setOf(
            StandardIntegrityErrorCode.NETWORK_ERROR,
            StandardIntegrityErrorCode.TOO_MANY_REQUESTS,
            StandardIntegrityErrorCode.GOOGLE_SERVER_UNAVAILABLE,
            StandardIntegrityErrorCode.CLIENT_TRANSIENT_ERROR,
            StandardIntegrityErrorCode.INTERNAL_ERROR,
            StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID,
        )
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnSuccessListener { cont.resume(it) }
    addOnFailureListener { cont.resumeWithException(it) }
    addOnCanceledListener { cont.cancel() }
}
