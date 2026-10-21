package net.palpost.library.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.models.LoginRequest
import net.palpost.library.api.models.LogoutRequest
import net.palpost.library.api.models.RefreshSessionRequest
import net.palpost.library.api.models.Session
import okhttp3.Authenticator
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/**
 * Owns the session: login, rotation of the refresh token, logout and revocation.
 *
 * - [bearerInterceptor] puts the access token on every call except the public auth ones (login, refresh, recovery) and refreshes it
 *   first when it is about to lapse.
 * - [authenticator] answers a `401` with one refresh and one retry; a second `401` on the same call is final.
 * - A refresh refused with `401` means the session was revoked (SEC-02): tokens are wiped and [state] flips
 *   to signed out so the UI returns to login. Network failures keep the tokens; the call just fails.
 * Refreshes are single-flight: concurrent callers wait, then reuse the token the first one obtained.
 */
class AuthManager(
    private val baseUrl: String,
    private val store: TokenStore,
    httpClient: OkHttpClient = OkHttpClient(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** The caller's client without any disk cache: login, refresh and API responses carry tokens and metadata. */
    private val httpClient: OkHttpClient = httpClient.newBuilder().cache(null).build()
    private val publicAuthApi = AuthApi(baseUrl, this.httpClient)
    private val apiHost: HttpUrl = baseUrl.toHttpUrl()
    private val refreshLock = Any()
    private val _state = MutableStateFlow<AuthState>(store.read()?.let { AuthState.SignedIn(it.userId) } ?: AuthState.SignedOut(null))
    val state: StateFlow<AuthState> = _state

    /**
     * HTTP client carrying the session; every API built for signed-in calls uses it. Never a disk cache, even if
     * the given client has one: API responses (tokens, material metadata) must not outlive the call on the phone.
     */
    val authenticatedClient: OkHttpClient by lazy {
        this.httpClient.newBuilder().addInterceptor(bearerInterceptor()).authenticator(authenticator()).build()
    }
    private val sessionApi by lazy { AuthApi(baseUrl, authenticatedClient) }

    fun currentTokens(): SessionTokens? = store.read()

    suspend fun login(email: String, password: String, totpCode: String?): Session {
        val session = publicAuthApi.login(LoginRequest(email = email, password = password, totpCode = totpCode?.takeIf { it.isNotBlank() }))
        val tokens = SessionTokens.from(session)
        store.write(tokens)
        _state.value = AuthState.SignedIn(tokens.userId)
        return session
    }

    /** Ends the session on the server when reachable, and always locally. */
    suspend fun logout(allSessions: Boolean = false) {
        try {
            if (store.read() != null) sessionApi.logout(LogoutRequest(allSessions = allSessions))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Already gone (4xx), server down (5xx) or offline: the server-side session lapses with its
            // refresh token either way; the device forgets it now.
        } finally {
            signOut(SignOutReason.USER)
        }
    }

    /**
     * Best effort alongside an emergency wipe: ask the server to end every session of this user, bounded by
     * [timeoutMs]. The access token is read once, here, so the local erase can run at the same time without
     * racing this request; a failure or timeout changes nothing locally and is recorded nowhere.
     */
    suspend fun revokeAllSessionsBestEffort(timeoutMs: Long = 3_000): Boolean {
        var tokens = store.read() ?: return false
        val started = clock()
        // A lapsed access token would make the server answer 401 and the revocation fail silently: rotate
        // first, inside the same budget (the wipe's guard keeps a 401 here from starting a second wipe).
        if (tokens.accessExpiresAtEpochMs - EXPIRY_SLACK_MS <= started) {
            tokens = withTimeoutOrNull(timeoutMs) { withContext(Dispatchers.IO) { refreshBlocking(tokens.accessToken) } } ?: return false
        }
        val token = tokens.accessToken
        val remainingMs = (timeoutMs - (clock() - started)).coerceAtLeast(200)
        val request = Request.Builder()
            .url("$baseUrl/auth/logout")
            .header(AUTHORIZATION, "Bearer $token")
            .post("""{"all_sessions":true}""".toRequestBody("application/json".toMediaType()))
            .build()
        // OkHttp's per-call deadline bounds connect, write and read together; the coroutine timeout is a backstop.
        return withTimeoutOrNull(remainingMs + 500) {
            withContext(Dispatchers.IO) {
                try {
                    httpClient.newCall(request).apply { timeout().timeout(remainingMs, TimeUnit.MILLISECONDS) }.execute().use { it.isSuccessful }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    false
                }
            }
        } ?: false
    }

    /** Forgets the session on this device without telling the server (the wipe does it; the server session lapses on its own). */
    fun forgetSession(reason: SignOutReason) = signOut(reason)

    private fun signOut(reason: SignOutReason) {
        store.clear()
        _state.value = AuthState.SignedOut(reason)
    }

    /**
     * Rotates the refresh token. [staleAccessToken] is the token the caller just used: if the store already
     * holds a different one, another caller refreshed meanwhile and that result is returned without a new call.
     */
    fun refreshBlocking(staleAccessToken: String?): SessionTokens? = synchronized(refreshLock) {
        val current = store.read() ?: return null
        if (staleAccessToken != null && current.accessToken != staleAccessToken) return current
        try {
            val session = runBlocking { publicAuthApi.refreshSession(RefreshSessionRequest(current.refreshToken)) }
            val tokens = SessionTokens.from(session)
            store.write(tokens)
            _state.value = AuthState.SignedIn(tokens.userId)
            tokens
        } catch (e: ClientException) {
            if (e.statusCode == 401) signOut(SignOutReason.SESSION_REVOKED)
            null
        } catch (e: IOException) {
            null
        }
    }

    /** The session token goes only to the API host, and only onto requests that carry no credential of their own. */
    fun bearerInterceptor(): Interceptor = Interceptor { chain ->
        val request = chain.request()
        if (!isApiHost(request.url) || isPublicAuthPath(request.url) || request.header(AUTHORIZATION) != null) return@Interceptor chain.proceed(request)
        var tokens = store.read() ?: return@Interceptor chain.proceed(request)
        if (tokens.accessExpiresAtEpochMs - EXPIRY_SLACK_MS <= clock()) tokens = refreshBlocking(tokens.accessToken) ?: tokens
        chain.proceed(request.withBearer(tokens.accessToken))
    }

    /** Refreshes and retries only requests whose bearer this manager attached (marked by [SessionBearer]). */
    fun authenticator(): Authenticator = Authenticator { _, response ->
        if (response.request.tag(SessionBearer::class.java) == null) return@Authenticator null
        if (response.priorResponse != null) return@Authenticator null // one refresh, one retry
        val sent = response.request.header(AUTHORIZATION)?.removePrefix("Bearer ") ?: return@Authenticator null
        val fresh = refreshBlocking(sent) ?: return@Authenticator null
        if (fresh.accessToken == sent) null else response.request.withBearer(fresh.accessToken)
    }

    private object SessionBearer

    private fun Request.withBearer(token: String) = newBuilder().header(AUTHORIZATION, "Bearer $token").tag(SessionBearer::class.java, SessionBearer).build()

    private fun isApiHost(url: HttpUrl): Boolean = url.host == apiHost.host && url.port == apiHost.port && url.scheme == apiHost.scheme

    private fun isPublicAuthPath(url: HttpUrl): Boolean {
        val path = url.encodedPath
        return PUBLIC_AUTH_PATHS.any { path.endsWith(it) }
    }

    private companion object {
        const val AUTHORIZATION = "Authorization"
        const val EXPIRY_SLACK_MS = 30_000L
        val PUBLIC_AUTH_PATHS = listOf("/auth/login", "/auth/refresh", "/auth/recovery")
    }
}
