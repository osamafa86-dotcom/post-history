"""قياس نموذج لغوي محلي صغير لمسودات العنوان والملخص (ADR 0026، البند 3).

يعمل على عينة عامة (XL-Sum العربية، اختبار) بلا شبكة، ويكتب نتيجة measurement.json:
ROUGE-L بالكلمات بعد تطبيع metrics.py مقابل العنوان والملخص المرجعيين، والزمن والذاكرة،
ونسبة المخرجات العربية، ومقارنة بخط أساس بلا نموذج (الجملة الأولى ملخصًا وأول الكلمات عنوانًا).

  python llm_bench.py run --model M.gguf --data arabic_test.jsonl --n 20 --threads 2 --out result.json

النموذج محلي بملف GGUF مثبّت البصمة، ولا مزوّد سحابي. لا تُحفظ نصوص العينة في المستودع، فقط المعرّفات والأرقام.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from metrics import words

ARTICLE_MAX_CHARS = 1500
TITLE_MAX_TOKENS = 32
SUMMARY_MAX_TOKENS = 96
SEED = 7

TITLE_PROMPT = "اكتب عنوانًا إخباريًا قصيرًا بالعربية الفصحى (عشر كلمات على الأكثر) لهذا الخبر. اكتب العنوان وحده."
SUMMARY_PROMPT = "لخّص هذا الخبر بالعربية الفصحى في جملة واحدة. اكتب الملخص وحده."


def lcs(a: list[str], b: list[str]) -> int:
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def rouge_l(reference: str, hypothesis: str) -> float:
    """F1 لأطول تتابع مشترك بالكلمات بعد التطبيع نفسه للطرفين."""
    ref, hyp = words(reference), words(hypothesis)
    if not ref or not hyp:
        return 0.0
    m = lcs(ref, hyp)
    if m == 0:
        return 0.0
    p, r = m / len(hyp), m / len(ref)
    return 2 * p * r / (p + r)


def arabic_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum("؀" <= c <= "ۿ" for c in letters) / len(letters)


def lead_baseline(text: str) -> tuple[str, str]:
    """بلا نموذج: أول جملة ملخصًا، وأول عشر كلمات منها عنوانًا."""
    first = text.replace("\n", " ").split(".")[0].strip()
    return " ".join(first.split()[:10]), first


def clean(out: str) -> str:
    line = next((ln.strip() for ln in out.strip().splitlines() if ln.strip()), "")
    return line.strip(" \"'«»").removeprefix("العنوان:").removeprefix("الملخص:").strip()


def sample(path: Path, n: int) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows.sort(key=lambda r: r["id"])
    return rows[:n]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(args: argparse.Namespace) -> dict:
    from llama_cpp import Llama  # المشغّل المحلي وحده، يُستورد عند التشغيل فقط

    started = datetime.now(timezone.utc)
    t0 = time.perf_counter()
    llm = Llama(model_path=str(args.model), n_ctx=2048, n_threads=args.threads, seed=SEED, verbose=False)
    load_s = time.perf_counter() - t0

    def ask(instruction: str, article: str, max_tokens: int) -> tuple[str, float, int]:
        t = time.perf_counter()
        r = llm.create_chat_completion(
            messages=[{"role": "user", "content": f"{instruction}\n\n{article[:ARTICLE_MAX_CHARS]}"}],
            temperature=0.0, max_tokens=max_tokens, seed=SEED)
        return clean(r["choices"][0]["message"]["content"]), time.perf_counter() - t, r["usage"]["completion_tokens"]

    items, lat, toks = [], [], 0
    for row in sample(args.data, args.n):
        title, t_s, t_tok = ask(TITLE_PROMPT, row["text"], TITLE_MAX_TOKENS)
        summary, s_s, s_tok = ask(SUMMARY_PROMPT, row["text"], SUMMARY_MAX_TOKENS)
        b_title, b_summary = lead_baseline(row["text"])
        lat.append(t_s + s_s)
        toks += t_tok + s_tok
        items.append({
            "id": row["id"],
            "title_rouge_l": round(rouge_l(row["title"], title), 4),
            "summary_rouge_l": round(rouge_l(row["summary"], summary), 4),
            "lead_title_rouge_l": round(rouge_l(row["title"], b_title), 4),
            "lead_summary_rouge_l": round(rouge_l(row["summary"], b_summary), 4),
            "arabic_share": round(min(arabic_share(title), arabic_share(summary)), 3),
            "empty": not title or not summary,
            "s": round(t_s + s_s, 2),
        })
    ended = datetime.now(timezone.utc)

    def mean(k: str) -> float:
        return round(statistics.fmean(i[k] for i in items), 4)

    return {
        "schema_version": 1,
        "tool": "asr-bench",
        "role": "ai",
        "test_name": f"llm-drafts-{args.label}",
        "started_at": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "ended_at": ended.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "result": "info",
        "device": {"platform": "server", "model": f"{platform.processor() or platform.machine()}, {args.threads} threads, CPU only",
                   "os_version": platform.platform()},
        "upload_path": "n/a",
        "file": {"codec": f"text: XL-Sum Arabic test, first {len(items)} by id, article cut to {ARTICLE_MAX_CHARS} chars"},
        "provider": f"local: llama.cpp, {args.model.name} sha256 {_sha256(args.model)}",
        "cost_usd": 0,
        "metrics": {
            "items": len(items),
            "title_rouge_l": mean("title_rouge_l"),
            "summary_rouge_l": mean("summary_rouge_l"),
            "lead_title_rouge_l": mean("lead_title_rouge_l"),
            "lead_summary_rouge_l": mean("lead_summary_rouge_l"),
            "arabic_share_min": min(i["arabic_share"] for i in items),
            "non_arabic_items": sum(i["arabic_share"] < 0.9 for i in items),
            "empty_items": sum(i["empty"] for i in items),
            "load_s": round(load_s, 2),
            "per_item_s_p50": round(statistics.median(lat), 2),
            "per_item_s_max": round(max(lat), 2),
            "completion_tokens_per_s": round(toks / sum(lat), 2),
            "peak_memory_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
            "network": args.network,
            "sample_ids": ",".join(i["id"] for i in items),
        },
        "notes": args.notes,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", type=Path, required=True)
    r.add_argument("--data", type=Path, required=True)
    r.add_argument("--n", type=int, default=20)
    r.add_argument("--threads", type=int, default=2)
    r.add_argument("--label", required=True)
    r.add_argument("--network", default="none (unshare -rn)")
    r.add_argument("--notes", default="")
    r.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    doc = run(args)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in doc["metrics"].items() if k != "sample_ids"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
