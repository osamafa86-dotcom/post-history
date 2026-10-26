"""القاموس المعتمد (ADR 0066): أسماء أماكن ومؤسسات عامة تُمرَّر إلى المحرك كلمات مفضّلة (`hotwords`).

- **المحتوى:** `kind` مكان أو مؤسسة فقط. يُرفض أي نوع آخر، فلا أسماء أشخاص ولا مصادر (قاعدة البيانات الكاشفة).
- **الحد:** faster-whisper يقصّ التلقين إلى نحو 223 رمزًا ويُبقي آخرها. فيُبنى النص بترتيب القاموس حتى
  `MAX_CHARS`، وما بعده لا يصل المحرك.
- **مطفأ افتراضيًا:** لا قاموس دون `AI_LEXICON_PATH`، ويُفعَّل بعد القياس في `docs/measurements/`.
"""

from __future__ import annotations

import json
from pathlib import Path

KINDS = {"place", "org"}
MAX_CHARS = 600


class LexiconError(ValueError):
    pass


def load(path: Path) -> list[dict]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    entries = doc.get("entries")
    if doc.get("format_version") != 1 or not isinstance(entries, list):
        raise LexiconError("unsupported lexicon format")
    seen = set()
    for e in entries:
        if set(e) - {"term", "kind", "variants"} or e.get("kind") not in KINDS:
            raise LexiconError("entry must be a place or an organisation, with term, kind and optional variants")
        term = str(e.get("term", "")).strip()
        if not term or term in seen:
            raise LexiconError("empty or duplicate term")
        seen.add(term)
    return entries


def hotwords(entries: list[dict], max_chars: int = MAX_CHARS) -> str:
    out, size = [], 0
    for e in entries:
        t = e["term"].strip()
        if size + len(t) + 1 > max_chars:
            break
        out.append(t)
        size += len(t) + 1
    return " ".join(out)
