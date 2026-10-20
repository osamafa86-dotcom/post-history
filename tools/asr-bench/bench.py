"""Run every pinned local model on the corpus without network and write one
measurement per model to docs/measurements/asr-bench/.

Each model runs in its own child under `unshare -rn` (a network namespace
with no interfaces) and with the Hugging Face hub forced offline, so a run
that tries to reach the network fails instead of measuring something else.
Peak memory is the child's max RSS from wait4.
"""
import argparse
import datetime as dt
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import metrics as M
from fetch import CACHE, LOCK

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT_DIR = REPO / "docs" / "measurements" / "asr-bench"
CUE_LIMIT_MS = 500.0
SETS = ("msa-read", "lev-synth", "ts-cues")
# Declared subsets for models too slow on this CPU for the full corpus. The
# measurement records the subset, so its numbers are never read as full-corpus.
SUBSETS = {
    # About 16x real time on 4 threads; no timestamps offline, so no ts-cues.
    "voxtral-rt-ar": {"msa-read": 10, "lev-synth": 40},
}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_child(model: str, hyp_path: Path, threads: int, limit: int | None, subset: dict | None) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", OMP_NUM_THREADS=str(threads))
    cmd = ["unshare", "-rn", sys.executable, str(HERE / "run_one.py"), "--model", model,
           "--out", str(hyp_path), "--threads", str(threads)]
    if limit:
        cmd += ["--limit", str(limit)]
    if subset:
        cmd += ["--subset", json.dumps(subset)]
    proc = subprocess.Popen(cmd, cwd=HERE, env=env)
    _, status, usage = os.wait4(proc.pid, 0)
    if os.waitstatus_to_exitcode(status) != 0:
        raise SystemExit(f"{model}: child failed with status {status}")
    return {"peak_rss_mb": round(usage.ru_maxrss / 1024.0, 1)}


def cue_boundaries(item: dict) -> tuple[list[float], list[float]] | None:
    segs = [s for s in item["segments"] if s["start"] is not None]
    if not segs:
        return None
    return [s["start"] for s in segs], [s["end"] for s in segs]


def score(model: str, hyp: dict, child: dict, manifest: list[dict], lexicon: list[str]) -> dict:
    ref = {e["id"]: e for e in manifest}
    m: dict = {"load_s": round(hyp["load_s"], 2), "peak_rss_mb": child["peak_rss_mb"], "threads": hyp["threads"]}
    all_pairs = []
    for s in SETS:
        items = [it for it in hyp["items"] if it["set"] == s]
        if not items:
            continue
        pairs = [(ref[it["id"]]["text"], it["text"]) for it in items]
        all_pairs += pairs
        audio_s = sum(ref[it["id"]]["duration_s"] for it in items)
        proc_s = sum(it["proc_s"] for it in items)
        w, c = M.corpus_error(pairs, "word"), M.corpus_error(pairs, "char")
        m.update({
            f"{s}__items": len(items),
            f"{s}__audio_s": round(audio_s, 1),
            f"{s}__wer_pct": round(w["rate_pct"], 2),
            f"{s}__cer_pct": round(c["rate_pct"], 2),
            f"{s}__ref_words": w["ref"],
            f"{s}__insertions": w["ins"],
            f"{s}__rtf_cpu": round(proc_s / audio_s, 3),
        })
    starts, ends, word_starts = [], [], []
    no_ts = 0
    for it in (it for it in hyp["items"] if it["set"] == "ts-cues"):
        truth = ref[it["id"]]["cues"]
        b = cue_boundaries(it)
        if b is None:
            no_ts += 1
            continue
        starts += M.boundary_errors([c["start"] for c in truth], b[0])
        ends += M.boundary_errors([c["end"] for c in truth], b[1])
        if it["words"]:
            word_starts += M.boundary_errors([c["start"] for c in truth], [w["start"] for w in it["words"]])
    if starts:
        both = starts + ends
        m.update({
            "cue_onset_err_ms_p50": round(M.percentile(starts, 50), 1),
            "cue_onset_err_ms_p95": round(M.percentile(starts, 95), 1),
            "cue_offset_err_ms_p50": round(M.percentile(ends, 50), 1),
            "cue_offset_err_ms_p95": round(M.percentile(ends, 95), 1),
            "cue_boundary_err_ms_max": round(max(both), 1),
            "cue_boundaries_within_500ms_pct": round(M.share_within(both, CUE_LIMIT_MS), 1),
            "cue_boundaries_scored": len(both),
        })
        if word_starts:
            m["word_onset_err_ms_p50"] = round(M.percentile(word_starts, 50), 1)
            m["word_onset_err_ms_p95"] = round(M.percentile(word_starts, 95), 1)
    else:
        m["timestamps"] = "not produced by this engine; not measured"
    if no_ts and starts:
        m["cue_clips_without_timestamps"] = no_ts
    e = M.entity_scores(all_pairs, lexicon)
    m["entities_in_ref"] = e["entities_in_ref"]
    m["entities_missed"] = e["entities_missed"]
    m["entities_invented"] = e["entities_invented"]
    return m


def cpu_model() -> str:
    for line in Path("/proc/cpuinfo").read_text().splitlines():
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return platform.processor() or "unknown"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*")
    ap.add_argument("--threads", type=int, default=os.cpu_count())
    ap.add_argument("--limit", type=int, help="smoke run: first N items per set; result is never pass")
    ap.add_argument("--keep-hyp", help="directory to keep raw transcripts (outside the repo)")
    args = ap.parse_args()

    lock = json.loads(LOCK.read_text())
    manifest = json.loads((CACHE / "corpus" / "manifest.json").read_text())
    selection = json.loads((HERE / "corpus.selection.json").read_text())
    lex = json.loads((HERE / "lexicon.json").read_text())
    lexicon = lex["places"] + lex["people"]
    hyp_dir = Path(args.keep_hyp or CACHE / "hyp")
    hyp_dir.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    gpu = "none detected" if subprocess.run(["sh", "-c", "command -v nvidia-smi"], capture_output=True).returncode else "present"

    for model in args.models or lock["models"]:
        spec = lock["models"][model]
        pin = lock["pins"][f"model:{spec['repo']}"]
        started = now()
        hyp_path = hyp_dir / f"{model}.json"
        subset = SUBSETS.get(model)
        child = run_child(model, hyp_path, args.threads, args.limit, subset)
        hyp = json.loads(hyp_path.read_text())
        metrics = score(model, hyp, child, manifest, lexicon)
        metrics.update({
            "engine": spec["engine"] + (" + silero vad" if spec.get("vad") else ""),
            "weights_revision": pin["revision"],
            "weights_sha256": next(p["sha256"] for p in pin["files"] if p["file"].endswith((".bin", ".safetensors"))),
            "gpu": gpu,
            "network": "none (unshare -rn, hub offline)",
            "corpus_subset": json.dumps(subset) if subset else "full",
        })
        doc = {
            "schema_version": 1,
            "tool": "asr-bench",
            "role": "ai",
            "test_name": "asr-local-arabic",
            "decision_ref": 7,
            "started_at": started,
            "ended_at": now(),
            "result": "info",
            "device": {"platform": "server", "model": f"{cpu_model()}, {args.threads} threads, CPU only",
                       "os_version": platform.platform()},
            "upload_path": "n/a",
            "provider": f"local: {spec['engine']} {spec['repo']}" + (f" ({spec['compute_type']})" if "compute_type" in spec else ""),
            "cost_usd": 0,
            "metrics": metrics,
            "notes": ("Public CC-BY-4.0 and synthetic audio only; no correspondent material. "
                      f"Corpus seed {selection['seed']}, {len(selection['items'])} clips pinned by sha256 in "
                      "tools/asr-bench/corpus.selection.json. WER/CER after the normalization in metrics.py. "
                      "lev-synth is TTS speech, not field recordings; result is info, not a standard."
                      + (f" Smoke run: first {args.limit} items per set." if args.limit else "")),
        }
        name = f"{started[:10]}-{model}.json" if not args.limit else f"smoke-{model}.json"
        (OUT_DIR / name if not args.limit else hyp_dir / name).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({k: v for k, v in metrics.items() if "wer" in k or "rtf" in k or "500" in k or "rss" in k}))


if __name__ == "__main__":
    main()
