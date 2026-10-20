"""Build the bench corpus from pinned public sources and local synthesis.

Offline: reads only files fetch.py already verified. Writes
16 kHz mono WAV and corpus/manifest.json under ASR_BENCH_CACHE, and the
committed selection (ids, references, sha256 of each WAV) to
tools/asr-bench/corpus.selection.json so a rerun can prove it used the same
audio.

Sets:
  msa-read      FLEURS ar_eg test (CC-BY-4.0): read Modern Standard Arabic.
  lev-synth     Lahgtna Levantine TTS (CC-BY-4.0): synthetic Levantine speech.
  ts-cues       Natural utterances from both sources joined with silence:
                exact utterance onset/offset truth for subtitle cues.

No word-level timing truth: espeak-ng Arabic proved unintelligible to every
model in a smoke run, so words read by it would measure the synthesizer.
"""
import hashlib
import io
import json
import random
import tarfile
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf
from faster_whisper.audio import decode_audio

from fetch import CACHE, LOCK, local_path

HERE = Path(__file__).resolve().parent
SR = 16000
OUT = CACHE / "corpus"
N_MSA, N_LEV, N_CUE_CLIPS, UTT_PER_CLIP = 40, 40, 12, 4
SEED = 20261020


def pinned(key: str, name: str) -> Path:
    lock = json.loads(LOCK.read_text())
    entry = lock["corpora"][key]
    rev = lock["pins"][f"dataset:{entry['repo']}"]["revision"]
    return local_path(entry["repo"], rev, name)


def to16k(data: bytes) -> np.ndarray:
    return decode_audio(io.BytesIO(data), sampling_rate=SR)


def trim_bounds(audio: np.ndarray, frame_ms: int = 10, below_peak_db: float = 35.0) -> tuple[int, int]:
    """First and last sample of frames within below_peak_db of the loudest frame."""
    hop = SR * frame_ms // 1000
    n = len(audio) // hop
    rms = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    active = np.nonzero(db >= db.max() - below_peak_db)[0]
    return int(active[0] * hop), int((active[-1] + 1) * hop)


def write(set_name: str, item_id: str, audio: np.ndarray) -> tuple[str, str]:
    path = OUT / set_name / f"{item_id}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio.astype(np.float32), SR, subtype="PCM_16")
    return str(path.relative_to(OUT)), hashlib.sha256(path.read_bytes()).hexdigest()


def msa_items() -> list[dict]:
    rows, seen = [], set()
    for line in pinned("fleurs-ar_eg", "data/ar_eg/test.tsv").read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if cols[0] not in seen:
            seen.add(cols[0])
            rows.append({"sentence_id": cols[0], "file": cols[1], "text": cols[2]})
    with tarfile.open(pinned("fleurs-ar_eg", "data/ar_eg/audio/test.tar.gz")) as tar:
        audio = {m.name.split("/")[-1]: tar.extractfile(m).read() for m in tar if m.isfile()}
    rows = [r for r in rows if r["file"] in audio][: N_MSA + UTT_PER_CLIP * N_CUE_CLIPS // 2]
    return [{**r, "audio": to16k(audio[r["file"]])} for r in rows]


def lev_items() -> list[dict]:
    table = pq.read_table(pinned("lahgtna-levantine", "data/train-00000-of-00024.parquet"))
    rows = [r for r in table.to_pylist() if r["sentence_type"] == "pure_levantine"]
    # Round-robin over speakers so no single synthetic voice dominates.
    by_spk: dict[str, list] = {}
    for i, r in enumerate(rows):
        by_spk.setdefault(r["speaker_id"], []).append((i, r))
    ordered = []
    while any(by_spk.values()):
        for spk in sorted(by_spk):
            if by_spk[spk]:
                ordered.append(by_spk[spk].pop(0))
    return [{"row": i, "speaker_id": r["speaker_id"], "text": r["text"], "audio": to16k(r["audio"]["bytes"])}
            for i, r in ordered[: N_LEV + UTT_PER_CLIP * N_CUE_CLIPS // 2]]


def ts_cues_items(msa_pool: list[dict], lev_pool: list[dict]) -> list[dict]:
    rng = random.Random(SEED + 1)
    items = []
    for c in range(N_CUE_CLIPS):
        pool = msa_pool if c % 2 == 0 else lev_pool
        parts = pool[UTT_PER_CLIP * (c // 2): UTT_PER_CLIP * (c // 2 + 1)]
        pieces, cues, t = [np.zeros(int(0.5 * SR), np.float32)], [], 0.5
        for k, p in enumerate(parts):
            if k:
                gap = rng.uniform(0.9, 1.4)
                pieces.append(np.zeros(int(gap * SR), np.float32))
                t += int(gap * SR) / SR
            s, e = trim_bounds(p["audio"])
            seg = p["audio"][s:e]
            cues.append({"text": p["text"], "start": round(t, 4), "end": round(t + len(seg) / SR, 4)})
            pieces.append(seg)
            t += len(seg) / SR
        pieces.append(np.zeros(int(0.5 * SR), np.float32))
        items.append({"id": f"cue-{c:02d}", "source": "msa-read" if c % 2 == 0 else "lev-synth",
                      "text": " ".join(p["text"] for p in parts), "cues": cues, "audio": np.concatenate(pieces)})
    return items


def main() -> None:
    msa, lev = msa_items(), lev_items()
    sets = {
        "msa-read": [{"id": f"fleurs-{r['file'][:-4]}", "text": r["text"], "audio": r["audio"],
                      "source": {"corpus": "fleurs-ar_eg", "file": r["file"]}} for r in msa[:N_MSA]],
        "lev-synth": [{"id": f"lahgtna-{r['row']:05d}", "text": r["text"], "audio": r["audio"],
                       "source": {"corpus": "lahgtna-levantine", "row": r["row"], "speaker_id": r["speaker_id"]}}
                      for r in lev[:N_LEV]],
        # Utterances for cue clips come after the ones used above, so no audio is reused.
        "ts-cues": ts_cues_items(msa[N_MSA:], lev[N_LEV:]),
    }
    manifest, selection = [], {"seed": SEED, "sample_rate": SR, "items": []}
    for set_name, items in sets.items():
        for it in items:
            rel, digest = write(set_name, it["id"], it["audio"])
            entry = {k: v for k, v in it.items() if k != "audio"}
            entry.update(set=set_name, path=rel, duration_s=round(len(it["audio"]) / SR, 3))
            manifest.append(entry)
            selection["items"].append({"set": set_name, "id": it["id"], "sha256": digest,
                                       "duration_s": entry["duration_s"]})
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    (HERE / "corpus.selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=1) + "\n")
    for s in sets:
        dur = sum(e["duration_s"] for e in manifest if e["set"] == s)
        print(f"{s}: {sum(e['set'] == s for e in manifest)} items, {dur / 60:.1f} min")


if __name__ == "__main__":
    main()
