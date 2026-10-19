package net.palpost.library.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with a key that lives in the Android Keystore and never leaves it. The key does not require
 * device unlock or user authentication, because background uploads must read tokens while the phone is
 * locked in a pocket. Blob layout: `[version=1][iv length][iv][ciphertext+tag]`.
 */
class KeystoreSealer(private val alias: String) {
    fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        return byteArrayOf(FORMAT_V1, iv.size.toByte()) + iv + cipher.doFinal(plain)
    }

    /** Throws [java.security.GeneralSecurityException] or [IllegalArgumentException] when the blob cannot be opened. */
    fun open(blob: ByteArray): ByteArray {
        require(blob.size > 2 && blob[0] == FORMAT_V1) { "unknown sealed blob format" }
        val ivLen = blob[1].toInt()
        require(ivLen in 12..16 && blob.size > 2 + ivLen) { "corrupt sealed blob" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, blob.copyOfRange(2, 2 + ivLen)))
        return cipher.doFinal(blob.copyOfRange(2 + ivLen, blob.size))
    }

    fun sealString(s: String): String = Base64.encodeToString(seal(s.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    fun openString(b64: String): String = String(open(Base64.decode(b64, Base64.NO_WRAP)), Charsets.UTF_8)

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        // A hardware security module when the phone has one; the regular TEE-backed Keystore otherwise.
        return try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec(true)) }.generateKey()
        } catch (e: StrongBoxUnavailableException) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec(false)) }.generateKey()
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val FORMAT_V1: Byte = 1
    }
}
