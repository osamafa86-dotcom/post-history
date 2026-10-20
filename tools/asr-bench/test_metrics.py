"""Metric tests: no weights, no audio, no network. Run in CI."""
import json
from pathlib import Path

import pytest

import metrics as M

HERE = Path(__file__).resolve().parent


def test_normalize_unifies_spelling_variants():
    assert M.normalize("أَحْمَدُ إلى الـمدرسةِ، يا مُصطفى!") == M.normalize("احمد الي المدرسه يا مصطفي")
    assert M.normalize("عام ٢٠٢٦") == "عام 2026"
    assert M.normalize("ليش الTraining؟") == "ليش الtraining"


def test_wer_counts_each_edit_type():
    r = M.corpus_error([("وصل الوفد الى غزة اليوم", "وصل وفد الى غزة اليوم صباحا")])
    assert (r["sub"], r["del"], r["ins"], r["ref"]) == (1, 0, 1, 5)
    assert r["rate_pct"] == pytest.approx(40.0)


def test_wer_is_corpus_level_not_mean_of_clips():
    pairs = [("a b c d", "a b c d"), ("x", "y")]
    assert M.corpus_error(pairs)["rate_pct"] == pytest.approx(20.0)


def test_cer_counts_spaces_after_normalization():
    assert M.corpus_error([("ab cd", "abcd")], "char")["del"] == 1


def test_identical_text_scores_zero_after_diacritics():
    assert M.corpus_error([("مَدِينَةُ غَزَّةَ", "مدينة غزة")])["rate_pct"] == 0.0


def test_alignment_reconstructs_both_sides():
    ref, hyp = list("kitten"), list("sitting")
    ops = M.align(ref, hyp)
    assert [ref[i] for op, i, _ in ops if i is not None] == ref
    assert [hyp[j] for op, _, j in ops if j is not None] == hyp
    assert sum(op != "eq" for op, _, _ in ops) == 3


def test_boundary_errors_measured_from_truth_side():
    # A model that merges two cues into one keeps only the outer boundaries.
    truth_starts = [0.5, 4.0]
    assert M.boundary_errors(truth_starts, [0.4]) == pytest.approx([100.0, 3600.0])
    assert M.boundary_errors(truth_starts, []) == []


def test_percentile_and_share():
    v = [float(x) for x in range(1, 101)]
    assert M.percentile(v, 50) == 50.0
    assert M.percentile(v, 95) == 95.0
    assert M.percentile([], 50) is None
    assert M.share_within([100.0, 499.0, 500.0, 501.0], 500.0) == 75.0


def test_timing_errors_only_for_exact_matches():
    ref = [{"word": "وصل", "start": 0.5, "end": 0.9}, {"word": "الوفد", "start": 1.0, "end": 1.5}]
    hyp = [{"word": " وصل", "start": 0.0, "end": 0.9}, {"word": "الوفود", "start": 1.0, "end": 1.5}]
    assert M.matched_word_timing_errors(ref, hyp) == [pytest.approx((500.0, 0.0))]


def test_entities_missed_and_invented():
    lex = ["خان يونس", "رفح", "غزة"]
    pairs = [("وصل الى خان يونس", "وصل الى خان"), ("في غزة", "في غزة ورفح")]
    e = M.entity_scores(pairs, lex)
    assert (e["entities_in_ref"], e["entities_missed"], e["entities_invented"]) == (2, 1, 0)
    # "ورفح" is not the whole word "رفح": prefixes are not stripped, so it is not counted.
    e = M.entity_scores([("في غزة", "في غزة رفح")], lex)
    assert e["entities_invented"] == 1


def test_measurements_have_required_fields_and_no_pass_claim():
    out = HERE.parent.parent / "docs" / "measurements" / "asr-bench"
    files = sorted(out.glob("*.json"))
    for f in files:
        doc = json.loads(f.read_text(encoding="utf-8"))
        assert doc["tool"] == "asr-bench"
        assert doc["result"] == "info", f"{f.name}: asr-bench reports info only (ADR 0017)"
        assert doc["metrics"]["network"].startswith("none")


def test_lock_pins_every_file():
    lock = json.loads((HERE / "models.lock.json").read_text())
    for group in ("models", "corpora"):
        for key, entry in lock[group].items():
            pin = lock["pins"][f"{entry.get('repo_type', 'model')}:{entry['repo']}"]
            assert len(pin["revision"]) == 40, key
            pinned = {p["file"]: p["sha256"] for p in pin["files"]}
            for name in entry["files"]:
                assert len(pinned[name]) == 64, f"{key}/{name}"
