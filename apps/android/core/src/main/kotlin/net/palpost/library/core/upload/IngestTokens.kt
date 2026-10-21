package net.palpost.library.core.upload

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.palpost.library.api.apis.UploadsApi
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.infrastructure.ServerException
import net.palpost.library.core.net.IdempotencyKey
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

/**
 * Produces the platform attestation for one request hash: a Play Integrity standard token on Android.
 * Throws [AttestationException] when the device cannot attest; [AttestationException.transient] says whether a
 * later attempt may succeed (network, quota) or never will on this install (no Play services, side-loaded APK).
 */
fun interface DeviceAttester {
    suspend fun attest(requestHash: String): String
}

class AttestationException(val transient: Boolean, message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Raised from the token source while a tus request is being prepared. [failure] null means retry later;
 * otherwise the task ends with that failure. Unchecked so it crosses tus-java-client's Java frames as is.
 */
class IngestTokenException(val failure: UploadFailure?, cause: Throwable? = null) : RuntimeException(cause)

/**
 * The short gate token of SEC-07 (ADR 0011) for each upload session: challenge → attestation over
 * `clientData = challenge ‖ session id` → `POST /uploads/{id}/ingest-token`. Tokens are cached per session and
 * fetched again [refreshBeforeMs] before they lapse, or at once after the gate answered 401 ([invalidate]).
 * Nothing here is logged: the token is a bearer credential for one session.
 */
class IngestTokens(
    private val uploadsApi: UploadsApi,
    private val attester: DeviceAttester?,
    private val clock: () -> Long = System::currentTimeMillis,
    private val refreshBeforeMs: Long = 60_000,
) {
    private class Cached(val token: String, val expiresAtMs: Long)

    private val cache = HashMap<String, Cached>()
    private val lock = Mutex()

    /** A valid token for [sessionId], fetched when none is cached or the cached one is about to lapse. */
    suspend fun current(sessionId: String): String = lock.withLock {
        cache[sessionId]?.takeIf { it.expiresAtMs - clock() > refreshBeforeMs }?.let { return it.token }
        val fresh = fetch(sessionId)
        cache[sessionId] = fresh
        fresh.token
    }

    /** For the transport, which prepares connections on a blocking thread. */
    fun currentBlocking(sessionId: String): String = runBlocking { current(sessionId) }

    /** The gate refused the token (401): the next request fetches a new one. */
    fun invalidate(sessionId: String) { runBlocking { lock.withLock { cache.remove(sessionId) } } }

    private suspend fun fetch(sessionId: String): Cached {
        val att = attester ?: throw IngestTokenException(UploadFailure.DEVICE_NOT_TRUSTED)
        try {
            val challenge = uploadsApi.createAttestationChallenge(IdempotencyKey.generate())
            val integrityToken = try {
                att.attest(requestHash(challenge.challenge, sessionId))
            } catch (e: AttestationException) {
                throw IngestTokenException(if (e.transient) null else UploadFailure.DEVICE_NOT_TRUSTED, e)
            }
            val token = uploadsApi.createIngestToken(
                IdempotencyKey.generate(),
                UUID.fromString(sessionId),
                net.palpost.library.api.models.IngestTokenRequest(platform = "android", challengeId = challenge.challengeId, integrityToken = integrityToken),
            )
            return Cached(token.token, token.expiresAt.toInstant().toEpochMilli())
        } catch (e: ClientException) {
            // 403 attestation_failed: Play does not recognise the app or device; 404: the session is gone.
            // 410 challenge_expired, 429 and 409 are worth another attempt with a new challenge.
            throw IngestTokenException(
                when (e.statusCode) {
                    403 -> UploadFailure.DEVICE_NOT_TRUSTED
                    404 -> UploadFailure.SESSION_EXPIRED
                    else -> null
                },
                e,
            )
        } catch (e: ServerException) {
            throw IngestTokenException(null, e) // 503 attestation_unavailable among them
        } catch (e: IOException) {
            throw IngestTokenException(null, e)
        }
    }

    companion object {
        /** `base64url(SHA-256(challenge bytes ‖ session id as text))`, unpadded, as the server recomputes it. */
        fun requestHash(challengeBase64Url: String, sessionId: String): String {
            val challenge = Base64.getUrlDecoder().decode(challengeBase64Url)
            val digest = MessageDigest.getInstance("SHA-256").apply { update(challenge); update(sessionId.toByteArray(Charsets.UTF_8)) }.digest()
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        }

    }
}
