"""خط أساس زمن التعديل البشري (الخطة: «خفض زمن التعديل البشري 30% على الأقل مقارنة بخط أساس يُقاس في التجربة الميدانية»).

بطاقة لكل جلسة عمل منتج، يملؤها المنتج أو المشرف، وتتحول إلى نتيجة بمخطط measurement.json:

    python tools/asr-bench/edit_baseline.py record <card.json> [--out-dir docs/measurements/asr-bench] [--dry-run]
    python tools/asr-bench/edit_baseline.py compare <baseline.json> <with-drafts.json>
    python tools/asr-bench/edit_baseline.py edit-ratio <draft.txt> <final.txt>

- **المرحلتان:** `baseline` قبل المسودات الآلية (التجربة الميدانية)، و`with-drafts` بعدها. `compare` يحسب الخفض لكل مهمة
  بدقائق العمل لكل دقيقة مادة، ولا يحكم: النتيجة `info`، والإعلان يحتاج عددًا كافيًا من المواد (`MIN_ITEMS`).
- **لا بيانات كاشفة:**
  - المنتج والمادة برمزين قصيرين يحفظهما المشرف خارج المستودع (`P1`، `M07`).
  - لا اسم ولا عنوان ولا معرّف مادة ولا نص.
  - الملاحظات الحرة تُرفض إن حملت ما يشبه هاتفًا أو بريدًا أو رابطًا.
- **`edit-ratio`:** حجم التعديل بين مسودة آلية ونصها النهائي، كنسبة أحرف مُعدَّلة بعد التطبيع نفسه في `metrics.py`.
  يُحسب محليًا ويطبع الرقم وحده، فلا يخرج النص من جهاز المشرف.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

import metrics as M

TASKS = ("transcript", "captions", "shot_list", "title_summary", "package")
PHASES = ("baseline", "with-drafts")
CODE = re.compile(r"^[A-Z]{1,2}[0-9]{1,3}$")
HHMM = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
REVEALING = [re.compile(p) for p in (r"[0-9][0-9 ()+-]{6,}[0-9]", r"@", r"https?://", r"www\.")]
MIN_ITEMS = 10  # أقل من ذلك لكل مهمة: الرقم يُطبع ولا يُبنى عليه
OUT_DIR = Path(__file__).resolve().parents[2] / "docs" / "measurements" / "asr-bench"


def _minutes(a: str, b: str) -> float:
    ha, ma = map(int, a.split(":"))
    hb, mb = map(int, b.split(":"))
    m = (hb * 60 + mb) - (ha * 60 + ma)
    return m if m >= 0 else m + 24 * 60  # جلسة تعبر منتصف الليل


def validate(card: dict) -> list[str]:
    bad = []
    if card.get("test_name") != "edit-baseline":
        bad.append("test_name must be edit-baseline")
    if card.get("phase") not in PHASES:
        bad.append(f"phase must be one of {PHASES}")
    try:
        dt.date.fromisoformat(str(card.get("performed_on")))
    except ValueError:
        bad.append("performed_on must be YYYY-MM-DD")
    if not CODE.match(str(card.get("producer", ""))):
        bad.append("producer must be a short code like P1 (no names)")
    items = card.get("items")
    if not isinstance(items, list) or not items:
        bad.append("items must be a non-empty list")
        items = []
    allowed = {"material", "task", "media_s", "started", "ended", "paused_min", "draft_used"}
    for i, it in enumerate(items):
        where = f"items[{i}]"
        if not isinstance(it, dict):
            bad.append(f"{where} must be an object")
            continue
        if extra := set(it) - allowed:
            bad.append(f"{where}: unknown fields {sorted(extra)} (free text goes in observations only)")
        if not CODE.match(str(it.get("material", ""))):
            bad.append(f"{where}.material must be a short code like M07 (no material id or title)")
        if it.get("task") not in TASKS:
            bad.append(f"{where}.task must be one of {TASKS}")
        if not (isinstance(it.get("media_s"), (int, float)) and it["media_s"] > 0):
            bad.append(f"{where}.media_s must be a positive number of seconds")
        for k in ("started", "ended"):
            if not HHMM.match(str(it.get(k, ""))):
                bad.append(f"{where}.{k} must be HH:MM")
        paused = it.get("paused_min", 0)
        if not (isinstance(paused, (int, float)) and paused >= 0):
            bad.append(f"{where}.paused_min must be ≥ 0")
        elif HHMM.match(str(it.get("started", ""))) and HHMM.match(str(it.get("ended", ""))):
            if _minutes(it["started"], it["ended"]) - paused <= 0:
                bad.append(f"{where}: no working time left after pauses")
        if card.get("phase") == "baseline" and it.get("draft_used"):
            bad.append(f"{where}: a baseline item cannot use an AI draft")
    obs = card.get("observations", "")
    if not isinstance(obs, str) or len(obs) > 500:
        bad.append("observations must be text of at most 500 characters")
    elif any(p.search(obs) for p in REVEALING):
        bad.append("observations look like they carry a phone, e-mail or link; remove it")
    return bad


def summarize(card: dict) -> dict:
    """دقائق العمل لكل دقيقة مادة، لكل مهمة: العدد والوسيط وp90 والمجموع."""
    by_task: dict[str, list[float]] = {}
    work_total = media_total = 0.0
    for it in card["items"]:
        work = _minutes(it["started"], it["ended"]) - it.get("paused_min", 0)
        media_min = it["media_s"] / 60
        by_task.setdefault(it["task"], []).append(work / media_min)
        work_total += work
        media_total += media_min
    m: dict = {"items": len(card["items"]), "work_min_total": round(work_total, 1),
               "media_min_total": round(media_total, 2)}
    for task, ratios in sorted(by_task.items()):
        m[f"{task}__n"] = len(ratios)
        m[f"{task}__work_per_media_min_p50"] = round(M.percentile(ratios, 50), 2)
        m[f"{task}__work_per_media_min_p90"] = round(M.percentile(ratios, 90), 2)
    return m


def record(card: dict) -> dict:
    bad = validate(card)
    if bad:
        raise ValueError("بطاقة غير صالحة:\n  " + "\n  ".join(bad))
    day = card["performed_on"]
    return {
        "schema_version": 1, "tool": "asr-bench", "role": "field-supervisor",
        "test_name": f"edit-{card['phase']}",
        "started_at": f"{day}T00:00:00Z", "ended_at": f"{day}T23:59:59Z",  # البطاقة تسجّل يومًا لا لحظات
        "result": "info",
        "device": {"platform": "other", "model": f"producer {card['producer']}"},
        "upload_path": "n/a",
        "metrics": summarize(card),
        "notes": ("Self-recorded editing time per material, minutes of work per minute of media, by task. "
                  "Codes only; no names, titles, ids or text. " + card.get("observations", "")).strip(),
    }


def compare(base: dict, after: dict) -> dict:
    """الخفض لكل مهمة بالوسيط: 1 − (بعد ÷ قبل). لا حكم إن قل العدد عن MIN_ITEMS في أي من المرحلتين."""
    out = {}
    tasks = {k.split("__")[0] for k in base["metrics"] if k.endswith("__n")}
    for t in sorted(tasks):
        nb, na = base["metrics"].get(f"{t}__n", 0), after["metrics"].get(f"{t}__n", 0)
        if not na:
            continue
        b = base["metrics"][f"{t}__work_per_media_min_p50"]
        a = after["metrics"][f"{t}__work_per_media_min_p50"]
        out[t] = {"baseline_p50": b, "with_drafts_p50": a,
                  "reduction_pct": round(100 * (1 - a / b), 1) if b else None,
                  "enough_items": nb >= MIN_ITEMS and na >= MIN_ITEMS}
    return out


def edit_ratio(draft: str, final: str) -> float:
    """أحرف مُعدَّلة ÷ أحرف النص النهائي بعد التطبيع؛ 0 = اعتُمدت المسودة كما هي."""
    c = M.corpus_error([(final, draft)], "char")
    return round(c["rate_pct"] / 100, 4)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("card")
    r.add_argument("--out-dir", default=str(OUT_DIR))
    r.add_argument("--dry-run", action="store_true")
    c = sub.add_parser("compare")
    c.add_argument("baseline")
    c.add_argument("after")
    e = sub.add_parser("edit-ratio")
    e.add_argument("draft")
    e.add_argument("final")
    a = ap.parse_args()
    if a.cmd == "record":
        card = json.loads(Path(a.card).read_text(encoding="utf-8"))
        try:
            doc = record(card)
        except ValueError as err:
            sys.exit(str(err))
        text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
        if a.dry_run:
            print(text)
            return
        path = Path(a.out_dir) / f"{card['performed_on']}-edit-{card['phase']}-{card['producer'].lower()}.json"
        path.write_text(text, encoding="utf-8")
        print("wrote", path)
    elif a.cmd == "compare":
        load = lambda p: json.loads(Path(p).read_text(encoding="utf-8"))  # noqa: E731
        print(json.dumps(compare(load(a.baseline), load(a.after)), ensure_ascii=False, indent=2))
    else:
        print(edit_ratio(Path(a.draft).read_text(encoding="utf-8"), Path(a.final).read_text(encoding="utf-8")))


if __name__ == "__main__":
    main()
