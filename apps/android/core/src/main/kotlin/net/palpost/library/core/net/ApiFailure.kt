package net.palpost.library.core.net

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.ClientError
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.infrastructure.ServerError
import net.palpost.library.api.infrastructure.ServerException
import java.io.IOException

/**
 * The `Error` body of a 4xx/5xx as the UI needs it: the stable `code` to branch on and the request id for
 * support. Read leniently so a code added to the contract later still surfaces instead of crashing.
 */
data class ApiFailure(val status: Int, val code: String?, val requestId: String?, val message: String?) {
    companion object {
        private val mapAdapter = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)).lenient()

        fun from(t: Throwable): ApiFailure? = when (t) {
            is ClientException -> parse(t.statusCode, (t.response as? ClientError<*>)?.body)
            is ServerException -> parse(t.statusCode, (t.response as? ServerError<*>)?.body)
            else -> null
        }

        private fun parse(status: Int, body: Any?): ApiFailure {
            val map = runCatching { (body as? String)?.let { mapAdapter.fromJson(it) } }.getOrNull()
            return ApiFailure(status, map?.get("code") as? String, map?.get("request_id") as? String, map?.get("message") as? String)
        }
    }
}

/** True for failures where retrying later can help (offline, timeouts, 5xx). */
fun Throwable.isTransient(): Boolean = this is IOException || this is ServerException
