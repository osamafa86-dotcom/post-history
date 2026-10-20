"""Transcribe the whole corpus with one model. Run by bench.py in a child
process without network, so peak memory and load time belong to one model.

Writes {"model", "load_s", "threads", "items": [{"id", "text", "segments",
"words", "proc_s"}]}. words is null when the engine gives no word times.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from fetch import CACHE, LOCK, local_path

SR = 16000


def model_dir(key: str) -> tuple[dict, Path]:
    lock = json.loads(LOCK.read_text())
    m = lock["models"][key]
    rev = lock["pins"][f"model:{m['repo']}"]["revision"]
    return m, local_path(m["repo"], rev, m["files"][0]).parent


class FasterWhisper:
    def __init__(self, spec: dict, path: Path, threads: int):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(str(path), device="cpu", compute_type=spec["compute_type"], cpu_threads=threads)
        # Silero VAD bundled with faster-whisper; no extra download.
        self.vad = bool(spec.get("vad"))

    def __call__(self, audio: np.ndarray) -> tuple[list, list]:
        segments, _ = self.model.transcribe(audio, language="ar", beam_size=5, word_timestamps=True,
                                            vad_filter=self.vad)
        segs, words = [], []
        for s in segments:
            segs.append({"start": s.start, "end": s.end, "text": s.text})
            words += [{"word": w.word, "start": w.start, "end": w.end} for w in (s.words or [])]
        return segs, words


class WhisperCpp:
    """whisper.cpp, the engine behind FFmpeg 8's whisper filter, with ggml quantized weights."""

    def __init__(self, spec: dict, path: Path, threads: int):
        from pywhispercpp.model import Model
        self.model = Model(str(path / spec["files"][0]), n_threads=threads, language="ar",
                           print_progress=False, print_realtime=False, redirect_whispercpp_logs_to=None)

    def __call__(self, audio: np.ndarray) -> tuple[list, None]:
        segs = self.model.transcribe(audio)
        # t0/t1 are in units of 10 ms.
        return [{"start": s.t0 / 100.0, "end": s.t1 / 100.0, "text": s.text} for s in segs], None


class VoxtralRealtime:
    """Offline use of a streaming model: the whole clip in one generate call, text only."""

    def __init__(self, spec: dict, path: Path, threads: int):
        import torch
        from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration
        torch.set_num_threads(threads)
        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(str(path))
        self.model = VoxtralRealtimeForConditionalGeneration.from_pretrained(str(path), dtype=torch.bfloat16)
        self.model.eval()

    def __call__(self, audio: np.ndarray) -> tuple[list, None]:
        inputs = self.processor(audio, return_tensors="pt").to(dtype=self.model.dtype)
        with self.torch.inference_mode():
            out = self.model.generate(**inputs, do_sample=False)
        text = self.processor.batch_decode(out, skip_special_tokens=True)[0]
        return [{"start": None, "end": None, "text": text}], None


ENGINES = {"faster-whisper": FasterWhisper, "whisper.cpp": WhisperCpp, "voxtral-realtime": VoxtralRealtime}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--limit", type=int, help="first N items per set, for smoke runs")
    ap.add_argument("--subset", help='JSON {set: max items}; sets left out are skipped')
    args = ap.parse_args()

    manifest = json.loads((CACHE / "corpus" / "manifest.json").read_text())
    if args.limit:
        manifest = [e for i, e in enumerate(manifest) if sum(x["set"] == e["set"] for x in manifest[:i]) < args.limit]
    if args.subset:
        cap = json.loads(args.subset)
        manifest = [e for i, e in enumerate(manifest)
                    if sum(x["set"] == e["set"] for x in manifest[:i]) < cap.get(e["set"], 0)]
    spec, path = model_dir(args.model)
    t0 = time.perf_counter()
    engine = ENGINES[spec["engine"]](spec, path, args.threads)
    load_s = time.perf_counter() - t0
    # Warm-up on 3 s of the first clip, untimed, so one-time kernel setup is not billed to an item.
    first, _ = sf.read(CACHE / "corpus" / manifest[0]["path"], dtype="float32")
    engine(first[: 3 * SR])

    items = []
    for e in manifest:
        audio, sr = sf.read(CACHE / "corpus" / e["path"], dtype="float32")
        assert sr == SR
        t = time.perf_counter()
        segs, words = engine(audio)
        proc = time.perf_counter() - t
        items.append({"id": e["id"], "set": e["set"], "text": " ".join(s["text"] for s in segs).strip(),
                      "segments": segs, "words": words, "proc_s": proc})
        print(f"{e['set']:9s} {e['id']:28s} {proc:6.2f}s / {e['duration_s']:5.1f}s", flush=True)
    Path(args.out).write_text(json.dumps({"model": args.model, "load_s": load_s, "threads": args.threads,
                                          "items": items}, ensure_ascii=False))


if __name__ == "__main__":
    main()
