package net.palpost.library.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.core.auth.SessionTokens
import net.palpost.library.core.auth.TokenStore
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Session tokens encrypted with an AES-256-GCM key that lives in the Android Keystore and never leaves it;
 * only the ciphertext sits in a private SharedPreferences file. The key does not require device unlock or
 * user authentication, because background uploads must be able to refresh the session while the phone is
 * locked in a pocket. Anything that fails to decrypt (key lost after a reset, tampering) reads as signed out.
 */
class KeystoreTokenStore(context: Context, private val alias: String = DEFAULT_ALIAS) : TokenStore {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val adapter = Serializer.moshi.adapter(SessionTokens::class.java)

    @Synchronized
    override fun read(): SessionTokens? {
        val encoded = prefs.getString(KEY_TOKENS, null) ?: return null
        return try {
            adapter.fromJson(String(decrypt(Base64.decode(encoded, Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (e: GeneralSecurityException) {
            clear(); null
        } catch (e: IllegalArgumentException) {
            clear(); null
        } catch (e: java.io.IOException) {
            clear(); null
        }
    }

    @Synchronized
    override fun write(tokens: SessionTokens) {
        val blob = encrypt(adapter.toJson(tokens).toByteArray(Charsets.UTF_8))
        // commit, not apply: a background job may read right after and must see the rotated token.
        prefs.edit().putString(KEY_TOKENS, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()
    }

    @Synchronized
    override fun clear() {
        prefs.edit().remove(KEY_TOKENS).commit()
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val sealed = cipher.doFinal(plain)
        return byteArrayOf(FORMAT_V1, iv.size.toByte()) + iv + sealed
    }

    private fun decrypt(blob: ByteArray): ByteArray {
        require(blob.size > 2 && blob[0] == FORMAT_V1) { "unknown token blob format" }
        val ivLen = blob[1].toInt()
        require(ivLen in 12..16 && blob.size > 2 + ivLen) { "corrupt token blob" }
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(blob.copyOfRange(2 + ivLen, blob.size))
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()
    }

    private companion object {
        const val DEFAULT_ALIAS = "net.palpost.library.session"
        const val PREFS = "session"
        const val KEY_TOKENS = "tokens"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val FORMAT_V1: Byte = 1
    }
}
