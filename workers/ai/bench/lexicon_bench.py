"""قياس أثر القاموس المعتمد (كلمات مفضّلة للمحرك) على أسماء الأماكن والمؤسسات، بلا مادة مراسلين، ونتيجته بمخطط measurement.json.

    python bench/lexicon_bench.py make <dir>      # خارج الحاوية: جمل عربية بأسماء من القاموس وجمل ضابطة بلا أسماء، بصوت espeak-ng
    docker run ... ai-worker:runtime ... python /bench/lexicon_bench.py run /set > result.json

يُفرَّغ كل ملف مرتين بالمحرك نفسه: بلا قاموس ثم به. المقاييس:
- إصابة الاسم في جمل الأسماء.
- الأسماء المختلقة: اسم من القاموس في الناتج وليس في المرجع، على كل الجمل وأولها الضابطة.
- WER بتطبيع asr-bench.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import platform
import random
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEXICON = HERE.parent / "lexicon" / "approved.json"
TEMPLATES = ["وصل الوفد إلى {} صباح اليوم", "أفاد مراسلنا في {} بأن الوضع هادئ", "تجمع الأهالي قرب {} بعد الظهر",
             "نقل الجرحى من {} إلى المستشفى", "أعلنت البلدية في {} عن خطة جديدة"]
CONTROLS = ["وصل الوفد صباح اليوم إلى المدينة", "أفاد مراسلنا بأن الوضع هادئ في المنطقة",
            "تجمع الأهالي في الساحة بعد الظهر", "نقلت سيارات الإسعاف الجرحى إلى المستشفى",
            "أعلنت البلدية عن خطة جديدة لإصلاح الطرق", "انقطعت الكهرباء عن الحي ساعات طويلة",
            "بدأ العام الدراسي في المدارس الحكومية", "ارتفعت أسعار الخضار في السوق المركزي",
            "عاد الصيادون إلى البحر بعد العاصفة", "افتتح معرض للكتاب في القاعة الكبرى",
            "شارك الطلاب في حملة لتنظيف الشوارع", "سقطت أمطار غزيرة على المرتفعات الليلة",
            "تأخرت الحافلات بسبب ازدحام الطريق", "زار الأطباء القرى البعيدة لتقديم العلاج",
            "اجتمع المجلس المحلي لمناقشة الموازنة", "أغلقت المحال التجارية أبوابها مبكرًا",
            "احتفل الأهالي بعودة الأسرى إلى بيوتهم", "تواصل العمل في بناء المدرسة الجديدة",
            "حذرت الأرصاد من موجة حر في الأيام القادمة", "استقبل المستشفى عشرات المرضى خلال الليل"]


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make(out: str, n: int = 40) -> None:
    d = Path(out)
    d.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(HERE.parent / "src"))
    from ai_worker import lexicon

    # من الأسماء التي تصل المحرك فعلًا (ما بعد حد التلقين لا يصل)
    terms = [e["term"] for e in lexicon.load(LEXICON) if e["term"] in lexicon.hotwords(lexicon.load(LEXICON))]
    rng = random.Random(7)
    picked = rng.sample(terms, n)
    items = [{"id": f"name-{i:02d}", "text": TEMPLATES[i % len(TEMPLATES)].format(t), "term": t}
             for i, t in enumerate(picked)]
    items += [{"id": f"control-{i:02d}", "text": t, "term": None} for i, t in enumerate(CONTROLS)]
    for it in items:
        subprocess.run(["espeak-ng", "-v", "ar", "-s", "150", "-w", str(d / f"{it['id']}.wav"), it["text"]], check=True)
    (d / "manifest.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def cgroup_peak_mb() -> float | None:
    for p in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(Path(p).read_text()) / 1048576, 1)
        except (OSError, ValueError):
            continue
    return None


def run(set_dir: str) -> None:
    sys.path.insert(0, os.environ.get("ASR_BENCH_DIR", "/asr-bench"))
    import metrics as M  # tools/asr-bench: التطبيع وWER نفسه

    from ai_worker import lexicon
    from ai_worker.transcribe import FasterWhisperEngine

    d = Path(set_dir)
    items = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    entries = lexicon.load(LEXICON)
    words = lexicon.hotwords(entries)
    terms = [M.normalize(e["term"]) for e in entries]
    model = os.environ.get("AI_MODEL", "faster-whisper-large-v3-turbo")
    started = now()
    engine = FasterWhisperEngine(Path(os.environ.get("AI_MODELS_DIR", "/models")) / model)
    out = {}
    for label, hw in (("base", None), ("lexicon", words)):
        engine.hotwords = hw
        t0 = time.perf_counter()
        hyps = {it["id"]: " ".join(s.text for s in engine.transcribe(d / f"{it['id']}.wav").segments) for it in items}
        took = time.perf_counter() - t0
        named = [it for it in items if it["term"]]
        hit = sum(M.normalize(it["term"]) in M.normalize(hyps[it["id"]]) for it in named)
        fabricated = sum(any(t in M.normalize(hyps[it["id"]]) and t not in M.normalize(it["text"]) for t in terms)
                         for it in items)
        controls_fab = sum(any(t in M.normalize(hyps[it["id"]]) for t in terms) for it in items if not it["term"])
        wer = M.corpus_error([(it["text"], hyps[it["id"]]) for it in items], unit="word")["rate_pct"]
        out[label] = {"term_hit": hit, "items_with_fabricated_term": fabricated, "controls_with_term": controls_fab,
                      "wer_pct": round(wer, 1), "transcribe_s": round(took, 1)}
    named_n = sum(1 for it in items if it["term"])
    m = {"items": len(items), "name_items": named_n, "control_items": len(items) - named_n,
         "lexicon_terms": len(entries), "hotwords_terms_sent": sum(e["term"] in words for e in entries),
         "hotwords_chars": len(words)}
    for label, v in out.items():
        m.update({f"{label}_{k}": val for k, val in v.items()})
    m.update({"peak_memory_mb": cgroup_peak_mb() or "not measured", "network": "none (docker --network none)"})
    doc = {
        "schema_version": 1, "tool": "asr-bench", "role": "ai", "test_name": "lexicon-hotwords-espeak-cpu",
        "started_at": started, "ended_at": now(), "result": "info",
        "device": {"platform": "server", "model": f"{os.environ.get('BENCH_CPU_MODEL', platform.processor())}, "
                                                  f"--cpus {os.environ.get('BENCH_CPUS', '?')}, CPU only",
                   "os_version": platform.platform()},
        "upload_path": "n/a",
        "file": {"codec": "wav, espeak-ng Arabic voice (synthetic)"},
        "provider": f"local: {engine.describe['name']} {model} ({engine.describe['compute_type']})",
        "cost_usd": 0, "metrics": m,
        "notes": ("Synthetic espeak-ng Arabic: 40 sentences each naming one dictionary term (random sample, seed 7) "
                  "and 20 control sentences with no name; each transcribed without and with the dictionary as "
                  "faster-whisper hotwords. Robotic speech raises WER for both; the comparison is the point. Real "
                  "field speech and dialect not measured. No correspondent material."),
    }
    print(json.dumps(doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    {"make": make, "run": run}[sys.argv[1]](sys.argv[2])
