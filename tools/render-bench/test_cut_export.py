"""القص والتصدير على حالة قصيرة، والكاشف يرى نقطة قص منزاحة (فلا ينجح القياس لأنه أعمى)."""

import random
from pathlib import Path

import cut_export
from av_sync import Case


def test_short_vfr_offset_case_passes(tmp_path: Path):
    r = cut_export.measure(Case("12s-vfr-offset", 20, vfr=True, start_offset=2.5), tmp_path, seed=7)
    assert r["pass"], r


def test_reference_detects_a_shifted_cut():
    segs = cut_export.segments_for(Case("x", 20), 0.0, random.Random(1))
    marks = [1.0, 3.0, 5.0, 7.0, 9.0, 11.0, 13.0, 15.0, 17.0]
    want = cut_export.expected_marks(marks, segs)
    shifted = [cut_export.Segment(s.start_us + 80_000, s.end_us + 80_000) for s in segs]
    moved = cut_export.expected_marks(marks, shifted)
    assert want and max(abs(a - b) for a, b in zip(want, moved)) >= 0.079
