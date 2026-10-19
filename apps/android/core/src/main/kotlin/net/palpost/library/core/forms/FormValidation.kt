package net.palpost.library.core.forms

/** One validation failure. `code` is from the shared vocabulary in tools/acceptance/form-conformance/README.md. */
data class FieldError(val field: String, val code: String)

data class ValidationResult(val errors: List<FieldError>) {
    val valid: Boolean get() = errors.isEmpty()
    fun errorFor(field: String): String? = errors.firstOrNull { it.field == field }?.code
}

/** Error codes, in the order the rules are checked per field. */
object ErrorCode {
    const val REQUIRED = "required"
    const val TYPE = "type"
    const val MIN_LENGTH = "min_length"
    const val MAX_LENGTH = "max_length"
    const val PATTERN = "pattern"
    const val MIN = "min"
    const val MAX = "max"
    const val OPTION = "option"
    const val MIN_ITEMS = "min_items"
    const val MAX_ITEMS = "max_items"
    const val NOT_BEFORE = "not_before"
    const val NOT_AFTER = "not_after"
    const val ACCEPT = "accept"
    const val MAX_SIZE_BYTES = "max_size_bytes"
}

/** The abstract value of one picked attachment as the validator sees it (`{mime, size_bytes}`). */
data class AttachmentValue(val mime: String, val sizeBytes: Long) {
    fun toMap(): Map<String, Any?> = mapOf("mime" to mime, "size_bytes" to sizeBytes)
}
