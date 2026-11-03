package net.palpost.library.core.upload

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer
import java.security.MessageDigest
import java.util.UUID

/**
 * Whom the upload rows, sends and receipts are shown to, and in whose name the authenticated upload requests go (ADR 0093, as
 * on iOS). An account is known on the phone by an opaque local id ([LocalAccounts]), never by its email or its server id.
 *
 * @property current the signed-in account's local id; null when nobody is signed in.
 * @property sole the only account that ever signed in on this phone (since this release); null when none or more than one.
 */
data class AccountScope(val current: String? = null, val sole: String? = null) {
    /**
     * A row whose owner is [owner] belongs to the signed-in account: shown to it alone, and its authenticated requests go in its
     * name alone. A row without an owner (an earlier release's) belongs to the signed-in account if it is the only one that ever
     * signed in here, else to nobody: it stays hidden and never asks in the name of an account that may not own it.
     */
    fun owns(owner: String?): Boolean {
        val c = current ?: return false
        return if (owner != null) owner == c else sole == c
    }

    /** The signed-in account's originals not yet finished: they carry on after sign-out, so sign-out asks first. */
    fun <T> pending(rows: List<T>, owner: (T) -> String?, open: (T) -> Boolean): Int = rows.count { open(it) && owns(owner(it)) }
}

/**
 * The accounts that signed in on this phone (ADR 0093): each gets a random local id, written into the upload rows and sends
 * instead of its email or server id. The key is the SHA-256 of the server id with a random salt of this phone, so the account
 * cannot be read from the file. The emergency wipe erases it with the queue; sign-out does not, because «who signed in here»
 * decides the rows of earlier releases.
 */
data class LocalAccounts(val salt: String = UUID.randomUUID().toString(), private val ids: Map<String, String> = emptyMap()) {
    val count: Int get() = ids.size

    /** The only account that signed in on the phone, if there is one. */
    val sole: String? get() = ids.values.singleOrNull()

    /** The account's local id, registering it on its first sign-in; returns the possibly updated record too. */
    fun register(serverAccount: String, newId: () -> String = { UUID.randomUUID().toString() }): Pair<LocalAccounts, String> {
        val key = digest(serverAccount)
        ids[key]?.let { return this to it }
        val fresh = newId()
        return copy(ids = ids + (key to fresh)) to fresh
    }

    fun localId(serverAccount: String): String? = ids[digest(serverAccount)]

    /** The scope with [serverAccount] signed in (or nobody). */
    fun scope(serverAccount: String?): AccountScope = AccountScope(serverAccount?.let(::localId), sole)

    fun toJson(): String = adapter.toJson(mapOf("salt" to salt, "ids" to ids))

    private fun digest(account: String): String =
        MessageDigest.getInstance("SHA-256").digest("$salt:${account.lowercase()}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    override fun toString(): String = "LocalAccounts(count=$count)"

    companion object {
        private val adapter = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java))

        /** Null when the text is not understood (the caller keeps what it has instead of writing a fresh record over it). */
        @Suppress("UNCHECKED_CAST")
        fun fromJson(json: String): LocalAccounts? = runCatching {
            val m = adapter.fromJson(json)!!
            LocalAccounts(m["salt"] as String, (m["ids"] as Map<String, Any?>).mapValues { it.value as String })
        }.getOrNull()
    }
}
