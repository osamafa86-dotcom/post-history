package net.palpost.library.auth

import android.content.Context
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.core.auth.SessionTokens
import net.palpost.library.core.auth.TokenStore
import java.io.IOException
import java.security.GeneralSecurityException

/**
 * Session tokens sealed by [KeystoreSealer]; only the ciphertext sits in a private SharedPreferences file.
 * Anything that fails to open (key lost after a reset, tampering) reads as signed out.
 */
class KeystoreTokenStore(context: Context, private val sealer: KeystoreSealer) : TokenStore {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val adapter = Serializer.moshi.adapter(SessionTokens::class.java)

    @Synchronized
    override fun read(): SessionTokens? {
        val sealed = prefs.getString(KEY_TOKENS, null) ?: return null
        return try {
            adapter.fromJson(sealer.openString(sealed))
        } catch (e: GeneralSecurityException) {
            clear(); null
        } catch (e: IllegalArgumentException) {
            clear(); null
        } catch (e: IOException) {
            clear(); null
        }
    }

    @Synchronized
    override fun write(tokens: SessionTokens) {
        // commit, not apply: a background job may read right after and must see the rotated token.
        prefs.edit().putString(KEY_TOKENS, sealer.sealString(adapter.toJson(tokens))).commit()
    }

    @Synchronized
    override fun clear() {
        prefs.edit().remove(KEY_TOKENS).commit()
    }

    private companion object {
        const val PREFS = "session"
        const val KEY_TOKENS = "tokens"
    }
}
