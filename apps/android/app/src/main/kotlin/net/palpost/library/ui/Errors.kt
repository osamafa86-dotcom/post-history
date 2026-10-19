package net.palpost.library.ui

import android.content.Context
import net.palpost.library.R
import net.palpost.library.core.net.ApiFailure
import java.io.IOException

/** Human text for a failed call, chosen by the contract's stable error code; never the server's raw message. */
fun describeFailure(context: Context, t: Throwable): String {
    val failure = ApiFailure.from(t)
    val text = when {
        failure == null -> if (t is IOException) context.getString(R.string.err_offline) else context.getString(R.string.err_unknown)
        failure.status >= 500 -> context.getString(R.string.err_server)
        else -> when (failure.code) {
            "unauthorized" -> context.getString(R.string.err_unauthorized)
            "totp_required" -> context.getString(R.string.err_totp_required)
            "rate_limited" -> context.getString(R.string.err_rate_limited)
            "validation_failed", "dynamic_fields_invalid" -> context.getString(R.string.err_validation_failed)
            "not_found" -> context.getString(R.string.err_not_found)
            else -> context.getString(R.string.err_unknown)
        }
    }
    val requestId = failure?.requestId
    return if (requestId != null && failure.status >= 500) "$text\n${context.getString(R.string.err_request_id, requestId)}" else text
}
