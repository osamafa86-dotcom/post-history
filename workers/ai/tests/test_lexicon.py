import json
from pathlib import Path

import pytest

from ai_worker.lexicon import MAX_CHARS, LexiconError, hotwords, load

APPROVED = Path(__file__).resolve().parents[1] / "lexicon" / "approved.json"


def _write(tmp_path, entries, version=1):
    p = tmp_path / "lex.json"
    p.write_text(json.dumps({"format_version": version, "entries": entries}, ensure_ascii=False), encoding="utf-8")
    return p


def test_the_approved_dictionary_loads_and_holds_no_people():
    entries = load(APPROVED)
    assert entries and {e["kind"] for e in entries} <= {"place", "org"}


@pytest.mark.parametrize("entries", [
    [{"term": "فلان", "kind": "person"}],          # no people: protected sources
    [{"term": "غزة", "kind": "place", "phone": "x"}],  # no unknown fields
    [{"term": "غزة", "kind": "place"}, {"term": "غزة", "kind": "place"}],
    [{"term": " ", "kind": "place"}],
])
def test_refuses_people_unknown_fields_and_duplicates(tmp_path, entries):
    with pytest.raises(LexiconError):
        load(_write(tmp_path, entries))


def test_hotwords_keep_dictionary_order_within_the_cap():
    entries = [{"term": f"اسم{i}", "kind": "place"} for i in range(400)]
    out = hotwords(entries)
    assert len(out) <= MAX_CHARS and out.startswith("اسم0 اسم1 ")
    assert hotwords(entries[:2]) == "اسم0 اسم1"
