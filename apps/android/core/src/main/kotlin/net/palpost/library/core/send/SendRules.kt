package net.palpost.library.core.send

import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import net.palpost.library.core.forms.ErrorCode
import net.palpost.library.core.forms.FieldError
import net.palpost.library.core.forms.FormValidator

/** The answer to the one sensitivity question «Does it include minors, injured people or graphic scenes?» (reporter-v2.md). */
enum class SensitivityGate { NO, YES }

/**
 * The one question and its three follow-ups, with no answer by default (spec 04, 04b, 04c). «No» means the three are
 * `false`, because the question names them; «Yes» opens the three, each with an explicit answer before sending.
 * Fixed here as the iOS review asked (ADR 0088 deferred notes): tapping the selected answer changes nothing, and answering a
 * follow-up pins the gate at «Yes», so a draft with partial answers never collapses to «No».
 */
data class SensitivityAnswers(
    val gate: SensitivityGate? = null,
    val minors: Boolean? = null,
    val injured: Boolean? = null,
    val graphic: Boolean? = null,
) {
    enum class Question { MINORS, INJURED, GRAPHIC }

    /** The answer as the screen shows it: the recorded one, else the one a four-step draft's three answers imply. */
    val effectiveGate: SensitivityGate? get() = gate ?: derivedGate(minors, injured, graphic)

    /** The three follow-ups are shown. */
    val followupsShown: Boolean get() = effectiveGate == SensitivityGate.YES

    val complete: Boolean get() = minors != null && injured != null && graphic != null

    /** True when any of the three is «Yes»; null while unanswered. */
    val sensitive: Boolean? get() = if (complete) minors == true || injured == true || graphic == true else null

    fun answer(g: SensitivityGate): SensitivityAnswers {
        if (g == effectiveGate) return copy(gate = g)
        return when (g) {
            SensitivityGate.NO -> SensitivityAnswers(SensitivityGate.NO, minors = false, injured = false, graphic = false)
            SensitivityGate.YES -> SensitivityAnswers(SensitivityGate.YES, null, null, null)
        }
    }

    fun answer(q: Question, value: Boolean): SensitivityAnswers = when (q) {
        Question.MINORS -> copy(gate = SensitivityGate.YES, minors = value)
        Question.INJURED -> copy(gate = SensitivityGate.YES, injured = value)
        Question.GRAPHIC -> copy(gate = SensitivityGate.YES, graphic = value)
    }

    fun valueOf(q: Question): Boolean? = when (q) {
        Question.MINORS -> minors
        Question.INJURED -> injured
        Question.GRAPHIC -> graphic
    }

    companion object {
        /** No answer, or the three «No», else «Yes» with what was answered. */
        fun derivedGate(minors: Boolean?, injured: Boolean?, graphic: Boolean?): SensitivityGate? {
            val answers = listOf(minors, injured, graphic)
            if (answers.all { it == null }) return null
            if (answers.all { it == false }) return SensitivityGate.NO
            return SensitivityGate.YES
        }
    }
}

/** What the screen knows of the office form (`SendFormCheck.state` once it has loaded). */
enum class FormState { READY, MISSING_FIELDS, INVALID_FIELDS, LOADING, UNAVAILABLE }

/**
 * What is missing before «Send N items», in the screen's order (reporter-v2.md «الإرسال»): the button stays disabled and says the
 * first reason. The same order and reasons as iOS (`SendReadiness`), without the display-name reason: on Android the display
 * name always has a value (the remembered one, `real_name` by default).
 */
object SendReadiness {
    enum class Reason {
        FILES, TITLE, TITLE_TOO_LONG_FOR_SET, TYPE,
        /** A tag typed in the field that cannot be added (longer than 40, or over 12): never lost silently on «Send». */
        PENDING_TAG,
        TAGS, PLACE, SENSITIVITY, FOLLOWUPS, PSEUDONYM,
        /** A required office-form field is empty. */
        FORM_FIELDS,
        /** A value in an office-form field (required or under «More») breaks its rule. */
        FORM_INVALID,
        FORM_LOADING, FORM_UNAVAILABLE;

        val isFormError: Boolean get() = this == FORM_FIELDS || this == FORM_INVALID
    }

    const val TITLE_MIN = 5

    /**
     * @param titleMax the longest base title the set allows (80 less the longest `(i/N)` suffix).
     * @param pinnedSuffixMax the longest suffix already pinned by an earlier attempt (it may be longer than what is left needs).
     */
    data class Snapshot(
        val fileCount: Int,
        val title: String,
        val titleMax: Int,
        val pinnedSuffixMax: Int = 0,
        val typeCount: Int,
        val tags: List<String>,
        val pendingTag: String = "",
        val governorate: String,
        val city: String,
        val sensitivity: SensitivityAnswers,
        val pseudonymMissing: Boolean = false,
        val form: FormState,
    )

    fun reasons(s: Snapshot): List<Reason> {
        val out = ArrayList<Reason>()
        if (s.fileCount == 0) out.add(Reason.FILES)
        val length = MaterialTagRules.length(s.title.trim())
        if (length < TITLE_MIN || length > MAX_TITLE) out.add(Reason.TITLE)
        else if (length > s.titleMax || length + s.pinnedSuffixMax > MAX_TITLE) out.add(Reason.TITLE_TOO_LONG_FOR_SET)
        if (s.typeCount == 0) out.add(Reason.TYPE)
        val tags = s.tags.toMutableList()
        if (!MaterialTagRules.commitPending(s.pendingTag, tags)) out.add(Reason.PENDING_TAG)
        if (tags.isEmpty() || !MaterialTagRules.isValidSet(tags)) out.add(Reason.TAGS)
        if (s.governorate.isBlank() || s.city.isBlank()) out.add(Reason.PLACE)
        when (s.sensitivity.effectiveGate) {
            null -> out.add(Reason.SENSITIVITY)
            SensitivityGate.YES -> if (!s.sensitivity.complete) out.add(Reason.FOLLOWUPS)
            SensitivityGate.NO -> Unit
        }
        if (s.pseudonymMissing) out.add(Reason.PSEUDONYM)
        when (s.form) {
            FormState.READY -> Unit
            FormState.MISSING_FIELDS -> out.add(Reason.FORM_FIELDS)
            FormState.INVALID_FIELDS -> out.add(Reason.FORM_INVALID)
            FormState.LOADING -> out.add(Reason.FORM_LOADING)
            FormState.UNAVAILABLE -> out.add(Reason.FORM_UNAVAILABLE)
        }
        return out
    }

    fun firstReason(s: Snapshot): Reason? = reasons(s).firstOrNull()

    /** The contract's upper bound for a material title (`MaterialCreate.title`). */
    const val MAX_TITLE = 80
}

/**
 * The office form on the one send screen (ADR 0088): required fields above the button, optional ones under «More». The errors
 * are the shared [FormValidator]'s (one per visible field), in screen order: required first, then those under «More». The first
 * decides the disabled reason: an empty required field is «missing», a value breaking its field's rule is «invalid».
 */
class SendFormCheck(form: UploadForm, materialType: MaterialType, values: Map<String, Any?>) {
    val requiredKeys: Set<String>
    val errors: List<FieldError>

    init {
        val visible = FormValidator.visibleFields(form, materialType, values)
        requiredKeys = visible.filter { it.required == true }.map { it.key }.toSet()
        val all = FormValidator.validate(form, materialType, values).errors
        errors = all.filter { it.field in requiredKeys } + all.filter { it.field !in requiredKeys }
    }

    val first: FieldError? get() = errors.firstOrNull()

    /** The first error is under «More»: the screen opens it before scrolling there. */
    val firstIsUnderMore: Boolean get() = first?.let { it.field !in requiredKeys } ?: false

    val state: FormState get() {
        val f = first ?: return FormState.READY
        return if (f.code == ErrorCode.REQUIRED) FormState.MISSING_FIELDS else FormState.INVALID_FIELDS
    }

    /** Shown under each field: a value error at once, «required» only once the form is what stops the send. */
    fun shownErrors(revealRequired: Boolean): List<FieldError> = errors.filter { it.code != ErrorCode.REQUIRED || revealRequired }
}
