package net.palpost.library.core.send

/**
 * The tag rule of the contract (`MaterialTag`, ADR 0086), with the same character classes as iOS (`MaterialTagRules`):
 * 1–40 code points, no JSON Schema `\s` space at either end, no control or bidi characters anywhere; and up to 12 tags
 * without repeats (`MaterialTags`). Tags are required in the v2 screens and optional in the contract.
 */
object MaterialTagRules {
    const val MAX_LENGTH = 40
    const val MAX_COUNT = 12

    /** The `\s` class of JSON Schema (ECMA-262) as the description of `MaterialTag` lists it. */
    fun isSchemaWhitespace(cp: Int): Boolean = when (cp) {
        in 0x09..0x0D, 0x20, 0xA0, 0x1680, in 0x2000..0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
        else -> false
    }

    /** C0, DEL and C1. */
    fun isControl(cp: Int): Boolean = cp in 0x00..0x1F || cp in 0x7F..0x9F

    /** The hidden direction marks: U+061C, U+200E/U+200F, U+202A–U+202E and U+2066–U+2069. */
    fun isBidiControl(cp: Int): Boolean = cp == 0x061C || cp == 0x200E || cp == 0x200F || cp in 0x202A..0x202E || cp in 0x2066..0x2069

    fun length(s: String): Int = s.codePointCount(0, s.length)

    /** Matches the contract's pattern character by character. */
    fun isValid(tag: String): Boolean {
        val cps = tag.codePoints().toArray()
        if (cps.isEmpty() || cps.size > MAX_LENGTH) return false
        if (cps.any { isControl(it) || isBidiControl(it) }) return false
        return !isSchemaWhitespace(cps.first()) && !isSchemaWhitespace(cps.last())
    }

    /** The set as the contract accepts it: every tag valid, at most 12, no exact repeats. */
    fun isValidSet(tags: List<String>): Boolean = tags.size <= MAX_COUNT && tags.toSet().size == tags.size && tags.all(::isValid)

    /**
     * What the reporter typed, before the check: whitespace (newline and tab included) becomes one space, hidden control and
     * bidi characters are dropped, and both ends are trimmed. So a tag that looks right never reaches the server and fails.
     */
    fun normalize(raw: String): String {
        val out = StringBuilder()
        var pendingSpace = false
        var i = 0
        while (i < raw.length) {
            val cp = raw.codePointAt(i)
            i += Character.charCount(cp)
            if (isSchemaWhitespace(cp)) { pendingSpace = out.isNotEmpty(); continue }
            if (isControl(cp) || isBidiControl(cp)) continue
            if (pendingSpace) out.append(' ')
            pendingSpace = false
            out.appendCodePoint(cp)
        }
        return out.toString()
    }

    sealed interface AddResult {
        data class Added(val tag: String) : AddResult
        /** Nothing left after normalising. */
        data object Empty : AddResult
        data object TooLong : AddResult
        /** Already there (ignoring the case of Latin letters). */
        data object Duplicate : AddResult
        data object LimitReached : AddResult
    }

    /** Adds what the reporter typed to [tags] when it is valid; says why not otherwise. */
    fun add(raw: String, tags: MutableList<String>): AddResult {
        val tag = normalize(raw)
        if (tag.isEmpty()) return AddResult.Empty
        if (length(tag) > MAX_LENGTH) return AddResult.TooLong
        if (tags.any { it.equals(tag, ignoreCase = true) }) return AddResult.Duplicate
        if (tags.size >= MAX_COUNT) return AddResult.LimitReached
        if (!isValid(tag)) return AddResult.Empty
        tags.add(tag)
        return AddResult.Added(tag)
    }

    /**
     * A tag typed in the field and not yet committed (no separator, no "done", the field kept its focus): it is committed on
     * "Send" when valid. True when the field may be cleared (added, empty, or already there); false when it cannot be added
     * (too long or over the limit), which stops the send instead of losing the tag silently.
     */
    fun commitPending(text: String, tags: MutableList<String>): Boolean = when (add(text, tags)) {
        is AddResult.Added, AddResult.Empty, AddResult.Duplicate -> true
        AddResult.TooLong, AddResult.LimitReached -> false
    }

    /** What ends a tag while typing: the Latin and Arabic commas and a new line. */
    val separators: Set<Char> = setOf(',', '\u060C', '\n')

    /** Splits the field's text at separators: complete tags before the last one, and what stays in the field after it. */
    fun split(text: String): Pair<List<String>, String> {
        if (text.none { it in separators }) return emptyList<String>() to text
        val parts = text.split(*separators.toCharArray())
        return parts.dropLast(1) to parts.last()
    }
}

/**
 * Arabic matching that ignores hamza forms, taa marbuta, alef maqsura, diacritics and tatweel, and the case of Latin
 * letters (design-brief.md §5.1); the same folding as iOS (`ArabicFold`).
 */
object ArabicFold {
    fun key(s: String): String {
        val out = StringBuilder()
        val lower = s.lowercase()
        var i = 0
        while (i < lower.length) {
            val cp = lower.codePointAt(i)
            i += Character.charCount(cp)
            when (cp) {
                in 0x064B..0x065F, 0x0670, 0x0640 -> Unit
                0x0622, 0x0623, 0x0625, 0x0671 -> out.append('\u0627')
                0x0629 -> out.append('\u0647')
                0x0649 -> out.append('\u064A')
                0x0624 -> out.append('\u0648')
                0x0626 -> out.append('\u064A')
                else -> out.appendCodePoint(cp)
            }
        }
        return out.toString()
    }
}

/** Tag suggestions from the reporter's earlier tags on this phone (the desk's list needs a later contract change, ADR 0086). */
object TagSuggestions {
    /**
     * With nothing typed: the latest earlier tags. While typing: those that start with the text first, then those that
     * contain it, by folded Arabic matching. A tag already in this send is not suggested again.
     */
    fun match(query: String, history: List<String>, current: List<String>, limit: Int = 6): List<String> {
        val taken = current.map(ArabicFold::key).toSet()
        val pool = history.filter { ArabicFold.key(it) !in taken }
        val q = ArabicFold.key(MaterialTagRules.normalize(query))
        if (q.isEmpty()) return pool.take(limit)
        val prefixed = pool.filter { ArabicFold.key(it).startsWith(q) }
        val containing = pool.filter { !ArabicFold.key(it).startsWith(q) && ArabicFold.key(it).contains(q) }
        return (prefixed + containing).take(limit)
    }
}
