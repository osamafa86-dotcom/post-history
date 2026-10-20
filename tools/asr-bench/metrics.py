"""Arabic text normalization, WER/CER with alignment, and timestamp errors.

Pure Python, no third-party imports, so CI can test it without weights.
"""
import math
import re
import unicodedata

# Tashkeel (fathatan..sukun), superscript alef, Quranic marks, tatweel.
_DIACRITICS = re.compile("[ً-ٰٟۖ-ۭـ]")
_CHAR_MAP = str.maketrans({
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
    "ى": "ي", "ئ": "ي", "ؤ": "و", "ة": "ه",
    **{chr(0x0660 + i): str(i) for i in range(10)},  # Arabic-Indic digits
    **{chr(0x06F0 + i): str(i) for i in range(10)},  # Extended Arabic-Indic digits
})


def normalize(text: str) -> str:
    """Normalization applied identically to reference and hypothesis.

    NFKC, drop diacritics and tatweel, unify alef/ya/hamza-seats/ta marbuta,
    Western digits, lowercase Latin, punctuation and symbols to spaces.
    """
    text = unicodedata.normalize("NFKC", text)
    text = _DIACRITICS.sub("", text)
    text = text.translate(_CHAR_MAP).lower()
    text = "".join(" " if unicodedata.category(c)[0] in "PS" else c for c in text)
    return " ".join(text.split())


def words(text: str) -> list[str]:
    return normalize(text).split()


def align(ref: list, hyp: list) -> list[tuple[str, int | None, int | None]]:
    """Levenshtein alignment. Returns ops (op, ref_index, hyp_index), op in eq/sub/del/ins."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1)
    ops = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    return ops[::-1]


def edit_counts(ref: list, hyp: list) -> dict:
    ops = align(ref, hyp)
    c = {"sub": 0, "del": 0, "ins": 0, "eq": 0}
    for op, _, _ in ops:
        c[op] += 1
    c["ref"] = len(ref)
    return c


def corpus_error(pairs: list[tuple[str, str]], unit: str = "word") -> dict:
    """Corpus-level error rate: total edits / total reference units, in percent.

    unit="word" gives WER; unit="char" gives CER over the normalized string
    with single spaces kept as characters.
    """
    tot = {"sub": 0, "del": 0, "ins": 0, "ref": 0}
    for ref, hyp in pairs:
        r = words(ref) if unit == "word" else list(normalize(ref))
        h = words(hyp) if unit == "word" else list(normalize(hyp))
        c = edit_counts(r, h)
        for k in tot:
            tot[k] += c[k]
    errors = tot["sub"] + tot["del"] + tot["ins"]
    rate = 100.0 * errors / tot["ref"] if tot["ref"] else 0.0
    return {"rate_pct": rate, **tot}


def matched_word_timing_errors(ref_words: list[dict], hyp_words: list[dict]) -> list[tuple[float, float]]:
    """Start/end absolute errors (ms) for reference words aligned as exact matches.

    ref_words and hyp_words: [{"word", "start", "end"}] with times in seconds.
    Only "eq" alignments count, so a misrecognized word never contributes a
    timing error; coverage is reported separately by the caller.
    """
    r = [normalize(w["word"]) for w in ref_words]
    h = [normalize(w["word"]) for w in hyp_words]
    out = []
    for op, i, j in align(r, h):
        if op == "eq":
            out.append((abs(hyp_words[j]["start"] - ref_words[i]["start"]) * 1000.0,
                        abs(hyp_words[j]["end"] - ref_words[i]["end"]) * 1000.0))
    return out


def boundary_errors(truth: list[float], predicted: list[float]) -> list[float]:
    """For each true boundary, distance (ms) to the nearest predicted boundary.

    Measured from the truth side so a model that merges or drops cues is
    penalized; an empty prediction yields no values and the caller must
    report that coverage gap.
    """
    if not predicted:
        return []
    return [min(abs(t - p) for p in predicted) * 1000.0 for t in truth]


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile, q in [0, 100]. None for an empty list."""
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, math.ceil(q / 100.0 * len(s)) - 1))
    return s[k]


def share_within(values: list[float], limit: float) -> float | None:
    if not values:
        return None
    return 100.0 * sum(v <= limit for v in values) / len(values)


def entity_scores(pairs: list[tuple[str, str]], lexicon: list[str]) -> dict:
    """Names and places: missed share and invented share against a lexicon.

    missed: lexicon entries present in the reference but absent from the
    hypothesis. invented: lexicon entries in the hypothesis absent from the
    reference. Matching is on normalized whole-word sequences.
    """
    lex = [normalize(e) for e in lexicon]

    def present(entry: str, text: str) -> bool:
        return f" {entry} " in f" {text} "

    in_ref = missed = invented = in_hyp = 0
    for ref, hyp in pairs:
        r, h = normalize(ref), normalize(hyp)
        for e in lex:
            if present(e, r):
                in_ref += 1
                missed += not present(e, h)
            elif present(e, h):
                in_hyp += 1
                invented += 1
    return {
        "entities_in_ref": in_ref,
        "entities_missed": missed,
        "entities_missed_pct": 100.0 * missed / in_ref if in_ref else None,
        "entities_invented": invented,
    }
