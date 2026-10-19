package net.palpost.library.core.forms

import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import net.palpost.library.api.models.UploadFormField
import java.math.BigDecimal
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/**
 * Validates `dynamic_fields` values against a form version exactly as the web, iOS and the server do.
 * The rules are the "Semantics" table of tools/acceptance/form-conformance/README.md; the judge is
 * cases.json in the same folder (run by FormConformanceTest). Values use the shapes Moshi produces for
 * JSON: String, Number, Boolean, List, Map (attachments are `{mime, size_bytes}` maps or [AttachmentValue]).
 */
object FormValidator {
    private val UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", Pattern.CASE_INSENSITIVE)
    private val RFC3339 = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$", Pattern.CASE_INSENSITIVE)

    /** Fields shown for this material type and these values, in form order. */
    fun visibleFields(form: UploadForm, materialType: MaterialType, values: Map<String, Any?>): List<UploadFormField> {
        val visible = LinkedHashMap<String, UploadFormField>()
        for (f in form.fields) {
            val types = f.materialTypes
            if (!types.isNullOrEmpty() && types.none { it.value == materialType.value }) continue
            val cond = f.condition
            if (cond != null) {
                if (!visible.containsKey(cond.field)) continue // a hidden controller hides what depends on it
                val cv = values[cond.field]
                val met = if (cv is List<*>) cv.any { looseEquals(it, cond.equals) } else looseEquals(cv, cond.equals)
                if (!met) continue
            }
            visible[f.key] = f
        }
        return visible.values.toList()
    }

    /** Errors in form field order, one per field: the first failing rule (required, type, then the type's rules). */
    fun validate(form: UploadForm, materialType: MaterialType, values: Map<String, Any?>): ValidationResult {
        val errors = ArrayList<FieldError>()
        for (f in visibleFields(form, materialType, values)) {
            checkField(f, values[f.key])?.let { errors.add(FieldError(f.key, it)) }
        }
        return ValidationResult(errors)
    }

    fun isEmpty(v: Any?): Boolean = v == null || v == "" || (v is Collection<*> && v.isEmpty())

    /** First failing rule code for one visible field, or null when it passes. */
    fun checkField(field: UploadFormField, v: Any?): String? {
        val val_ = field.validation
        if (isEmpty(v)) return if (field.required) ErrorCode.REQUIRED else null
        return when (field.type) {
            UploadFormField.Type.short_text, UploadFormField.Type.long_text -> {
                if (v !is String) return ErrorCode.TYPE
                val n = v.codePointCount(0, v.length)
                val minLength = val_?.minLength
                val maxLength = val_?.maxLength
                if (minLength != null && n < minLength) return ErrorCode.MIN_LENGTH
                if (maxLength != null && n > maxLength) return ErrorCode.MAX_LENGTH
                val pattern = val_?.pattern
                if (pattern != null && !matches(pattern, v)) return ErrorCode.PATTERN
                null
            }
            UploadFormField.Type.number -> {
                val d = asFiniteNumber(v) ?: return ErrorCode.TYPE
                val min = val_?.min
                val max = val_?.max
                if (min != null && d < min) return ErrorCode.MIN
                if (max != null && d > max) return ErrorCode.MAX
                null
            }
            UploadFormField.Type.select -> {
                if (v !is String) return ErrorCode.TYPE
                if (val_?.options.orEmpty().none { it.value == v }) ErrorCode.OPTION else null
            }
            UploadFormField.Type.multi_select -> {
                if (v !is List<*> || v.any { it !is String }) return ErrorCode.TYPE
                itemCountError(v.size, val_?.minItems, val_?.maxItems)?.let { return it }
                val options = val_?.options.orEmpty()
                if (v.all { x -> options.any { it.value == x } }) null else ErrorCode.OPTION
            }
            UploadFormField.Type.datetime -> {
                if (v !is String) return ErrorCode.TYPE
                val t = instant(v) ?: return ErrorCode.TYPE
                val notBefore = val_?.notBefore
                val notAfter = val_?.notAfter
                if (notBefore != null && t < notBefore.toInstant().toEpochMilli()) return ErrorCode.NOT_BEFORE
                if (notAfter != null && t > notAfter.toInstant().toEpochMilli()) return ErrorCode.NOT_AFTER
                null
            }
            UploadFormField.Type.boolean -> if (v is Boolean) null else ErrorCode.TYPE
            UploadFormField.Type.staff_member -> if (v is String && UUID.matcher(v).matches()) null else ErrorCode.TYPE
            UploadFormField.Type.attachment -> {
                if (v !is List<*>) return ErrorCode.TYPE
                val items = v.map { attachment(it) ?: return ErrorCode.TYPE }
                itemCountError(items.size, val_?.minItems, val_?.maxItems)?.let { return it }
                val accept = val_?.accept.orEmpty()
                if (items.any { a -> accept.none { mimeAccepted(a.mime, it) } }) return ErrorCode.ACCEPT
                val maxSize = val_?.maxSizeBytes
                if (maxSize != null && items.any { it.sizeBytes > maxSize }) return ErrorCode.MAX_SIZE_BYTES
                null
            }
            // Not allowed in v0 forms (schema gate); a value for it can never be valid on this client.
            UploadFormField.Type.location -> ErrorCode.TYPE
        }
    }

    private fun itemCountError(n: Int, min: Long?, max: Long?): String? = when {
        min != null && n < min -> ErrorCode.MIN_ITEMS
        max != null && n > max -> ErrorCode.MAX_ITEMS
        else -> null
    }

    private fun attachment(x: Any?): AttachmentValue? {
        if (x is AttachmentValue) return x
        if (x !is Map<*, *>) return null
        val mime = x["mime"] as? String ?: return null
        val size = x["size_bytes"] as? Number ?: return null
        val d = size.toDouble()
        if (!d.isFinite() || d != Math.floor(d)) return null
        return AttachmentValue(mime, size.toLong())
    }

    private fun mimeAccepted(mime: String, accept: String): Boolean =
        if (accept.endsWith("/*")) mime.startsWith(accept.dropLast(1)) else accept == mime

    /** A JSON number as BigDecimal, or null when the value is not a finite number (JS `typeof v !== "number"`). */
    private fun asFiniteNumber(v: Any?): BigDecimal? = when (v) {
        is BigDecimal -> v
        is Int, is Long, is Short, is Byte -> BigDecimal.valueOf((v as Number).toLong())
        is Number -> v.toDouble().takeIf { it.isFinite() }?.let { BigDecimal(it.toString()) }
        else -> null
    }

    /** RFC 3339 date-time → epoch millis of the instant; null when not a full date-time. */
    private fun instant(s: String): Long? {
        if (!RFC3339.matcher(s).matches()) return null
        return try {
            OffsetDateTime.parse(s.uppercase()).toInstant().toEpochMilli()
        } catch (e: DateTimeParseException) {
            null
        }
    }

    /** ECMA-262 pattern, matched anywhere unless anchored. A pattern Java cannot compile does not block the user. */
    private fun matches(pattern: String, s: String): Boolean = try {
        Pattern.compile(pattern).matcher(s).find()
    } catch (e: PatternSyntaxException) {
        true
    }

    /** JS `===` over JSON scalars: numbers compare by value whatever their boxed type. */
    private fun looseEquals(a: Any?, b: Any?): Boolean =
        if (a is Number && b is Number) a.toDouble() == b.toDouble() else a == b
}
