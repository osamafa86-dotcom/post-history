package net.palpost.library.core.auth

import net.palpost.library.api.models.Session

/** What the app keeps of a `Session`: the two tokens, when the access token lapses, and whose they are. */
data class SessionTokens(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAtEpochMs: Long,
    val userId: String,
) {
    companion object {
        fun from(session: Session) = SessionTokens(
            accessToken = session.accessToken,
            refreshToken = session.refreshToken,
            accessExpiresAtEpochMs = session.expiresAt.toInstant().toEpochMilli(),
            userId = session.userId.toString(),
        )
    }
}

/** Where tokens rest. On Android this is backed by the Keystore (KeystoreTokenStore); tests use memory. */
interface TokenStore {
    fun read(): SessionTokens?
    fun write(tokens: SessionTokens)
    fun clear()
}

class InMemoryTokenStore(initial: SessionTokens? = null) : TokenStore {
    @Volatile private var tokens: SessionTokens? = initial
    override fun read(): SessionTokens? = tokens
    override fun write(tokens: SessionTokens) { this.tokens = tokens }
    override fun clear() { tokens = null }
}

sealed interface AuthState {
    data class SignedIn(val userId: String) : AuthState
    data class SignedOut(val reason: SignOutReason?) : AuthState
}

enum class SignOutReason { USER, SESSION_REVOKED }
