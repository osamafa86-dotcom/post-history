"""خط أساس زمن التعديل: البطاقة، والحساب، والمقارنة، ورفض البيانات الكاشفة. بلا شبكة ولا ملفات حقيقية."""

import json
from pathlib import Path

import pytest

import edit_baseline as E

HERE = Path(__file__).resolve().parent


def card(**over):
    c = json.loads((HERE / "edit-baseline.card.template.json").read_text(encoding="utf-8"))
    c.update(over)
    return c


def test_template_is_a_valid_card_and_records_info():
    doc = E.record(card())
    assert doc["result"] == "info" and doc["test_name"] == "edit-baseline" and doc["tool"] == "asr-bench"
    m = doc["metrics"]
    # transcript: 22 min of work for 95 s of media = 13.89 min per media minute
    assert m["transcript__n"] == 1 and m["transcript__work_per_media_min_p50"] == pytest.approx(13.89, abs=0.01)
    # shot_list: 26 min minus a 4-minute pause, for 3 media minutes
    assert m["shot_list__work_per_media_min_p50"] == pytest.approx(22 / 3, abs=0.01)
    assert m["work_min_total"] == pytest.approx(22 + 8 + 22)


@pytest.mark.parametrize("over,needle", [
    ({"producer": "Ahmad"}, "producer"),
    ({"phase": "pilot"}, "phase"),
    ({"performed_on": "01/11/2026"}, "performed_on"),
    ({"observations": "اتصل على 0599123456"}, "phone"),
    ({"observations": "see https://example.org"}, "link"),
    ({"items": [{"material": "a0000000-0000-4000-8000-000000000001", "task": "transcript", "media_s": 60,
                 "started": "09:00", "ended": "09:10"}]}, "material"),
    ({"items": [{"material": "M1", "task": "transcript", "media_s": 60, "started": "09:00", "ended": "09:10",
                 "title": "قصف في مخيم"}]}, "unknown fields"),
    ({"items": [{"material": "M1", "task": "transcript", "media_s": 60, "started": "09:00", "ended": "09:05",
                 "paused_min": 5}]}, "no working time"),
    ({"items": [{"material": "M1", "task": "transcript", "media_s": 60, "started": "09:00", "ended": "09:10",
                 "draft_used": True}]}, "baseline item cannot"),
])
def test_invalid_or_revealing_cards_are_refused(over, needle):
    errors = E.validate(card(**over))
    assert any(needle in e for e in errors), errors
    with pytest.raises(ValueError):
        E.record(card(**over))


def test_session_crossing_midnight():
    c = card(items=[{"material": "M1", "task": "package", "media_s": 120, "started": "23:50", "ended": "00:20"}])
    assert E.record(c)["metrics"]["package__work_per_media_min_p50"] == 15.0


def test_compare_reports_reduction_and_whether_there_are_enough_items():
    def doc(phase, minutes, n):
        items = [{"material": f"M{i}", "task": "transcript", "media_s": 60, "started": "09:00",
                  "ended": f"09:{minutes:02d}", "draft_used": phase == "with-drafts"} for i in range(n)]
        return E.record(card(phase=phase, items=items))
    small = E.compare(doc("baseline", 20, 3), doc("with-drafts", 12, 3))["transcript"]
    assert small == {"baseline_p50": 20.0, "with_drafts_p50": 12.0, "reduction_pct": 40.0, "enough_items": False}
    assert E.compare(doc("baseline", 20, 12), doc("with-drafts", 12, 12))["transcript"]["enough_items"] is True


def test_edit_ratio_ignores_diacritics_and_counts_real_edits():
    assert E.edit_ratio("وصل الوفد إلى غزة", "وَصَلَ الوَفْدُ إلى غزّة") == 0.0
    r = E.edit_ratio("وصل الوفد الى غزه", "وصل الوفد إلى رفح")
    assert 0 < r < 0.5
