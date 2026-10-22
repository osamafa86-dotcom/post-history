"""حزمة تسليم المشتري (المرحلة التجارية، ADR 0025): النسخ المرخّصة بصيغها كما يحددها قالب الترخيص في
`deliverables` (`original` و`produced` و`audio` و`stills`)، بلا بيانات كاشفة كحزمة التصدير (#126).

- `original`: نسخ تيارات الأصل بلا ترميز إلى ملف جديد بلا وسوم ولا مسارات بيانات أو ترجمة (`strip_metadata`).
- `audio`: WAV PCM 16 بت 48 kHz من أول مسار صوت، بلا وسوم ولا مقطع LIST.
- `stills`: خمس صور JPEG بالدقة الكاملة عند 10% و30% و50% و70% و90% من المدة، SDR، بلا EXIF ولا وسوم.
- `produced` (من التصدير النهائي) ليس من الأصل: يُذكر في `manifest.json` بحالة `not_available` حين لا يُمرَّر
  ملفه، ولا يُختلق.
- التفريغ لا يدخل التسليم (قرار المنسّق R11 على #178، حتى ADR للحجب الآلي): بند غير معروف يُرفض.
- `manifest.json` بمعرّف الترخيص وحالة كل بند (بلا بصمة الأصل)، و`SHA256SUMS` لكل ملف؛ الأرشيف حتمي.

الأصل يُقرأ فقط وتُعاد مطابقة بصمته قبل البناء. المدخل مقيد بـ `INPUT_GUARD`.
"""

from __future__ import annotations

import json
import os
import zipfile
from collections.abc import Callable
from pathlib import Path

from .export import EXTENSIONS, _add, strip_metadata
from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .hashing import digest_file
from .probe import Probe
from .proxy import video_filter

DELIVERABLES = ("original", "produced", "audio", "stills")
STILL_POINTS = (0.1, 0.3, 0.5, 0.7, 0.9)
MANIFEST_SCHEMA = "post-history/delivery@1"


def _wav(src: Path, dst: Path, timeout_s: float) -> None:
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *INPUT_GUARD, "-i", str(src),
         "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-map_chapters", "-1",
         "-c:a", "pcm_s16le", "-ar", "48000", "-fflags", "+bitexact", "-flags:a", "+bitexact",
         "-rf64", "auto", "-f", "wav", str(dst)], timeout_s=timeout_s, cwd=dst.parent)


def _still(src: Path, dst: Path, info: Probe, at_s: float) -> None:
    # الضلع القصير الكامل: video_filter لا يكبّر، فيبقى الإطار بدقته مع خريطة الألوان لـ HDR
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{at_s:.3f}", *INPUT_GUARD,
         "-i", str(src), "-map", "0:v:0", "-map_metadata", "-1", "-map_chapters", "-1",
         "-vf", video_filter(info, 100_000), "-frames:v", "1", "-q:v", "2", "-f", "image2", "-c:v", "mjpeg",
         str(dst)], timeout_s=120, cwd=dst.parent)


def build_delivery(out: Path, *, original: Path, info: Probe, license_id: str, sha256: str,
                   deliverables: list[str], extras: dict[str, Path] | None = None,
                   sign: Callable[[Path, list[str]], Path] | None = None) -> dict:
    """يكتب الأرشيف ذريًا ويعيد البيان. `extras` لملف `produced` إن وُجد، تُضمَّن كما هي (يوقَّع عند بنائه).
    `sign(ملف، إجراءات) -> ملف موقَّع جديد` يوقّع C2PA ما يبنيه التسليم من الأصل (ADR 0060)، قبل حساب البصمات."""
    unknown = set(deliverables) - set(DELIVERABLES)
    if unknown or not deliverables:
        raise ValueError(f"unknown deliverables: {sorted(unknown)}")
    if digest_file(original).sha256 != sha256:
        raise ValueError("original changed since verification")
    extras = extras or {}
    work = out.with_name(out.name + ".work")
    work.mkdir(exist_ok=True)
    timeout = max(120.0, info.duration_ms / 1000 * 2)
    files: list[tuple[str, Path, bool]] = []  # (اسم داخل الأرشيف، المصدر، بلا ضغط)
    status: dict[str, object] = {}
    try:
        for item in DELIVERABLES:
            if item not in deliverables:
                continue
            if item == "original":
                ext = "mov" if info.video_codec == "hevc" else EXTENSIONS.get(info.container, "mov")
                name = f"original.{ext}"
                strip_metadata(original, work / name, timeout, video_codec=info.video_codec)
                files.append((name, sign(work / name, []) if sign else work / name, True))
                status[item] = [name]
            elif item == "audio" and info.audio_codec:
                _wav(original, work / "audio.wav", timeout)
                wav = work / "audio.wav"
                files.append(("audio.wav", sign(wav, ["c2pa.transcoded"]) if sign else wav, False))
                status[item] = ["audio.wav"]
            elif item == "stills" and info.video_codec:
                names = []
                for i, p in enumerate(STILL_POINTS, 1):
                    name = f"stills/still_{i:02d}.jpg"
                    path = work / f"still_{i:02d}.jpg"
                    _still(original, path, info, info.duration_ms / 1000 * p)
                    actions = ["c2pa.transcoded"] + (["c2pa.color_adjustments"] if info.hdr else [])
                    files.append((name, sign(path, actions) if sign else path, True))
                    names.append(name)
                status[item] = names
            elif item == "produced" and item in extras:
                name = f"{item}{extras[item].suffix}"
                files.append((name, extras[item], True))
                status[item] = [name]
            else:
                status[item] = "not_available"
        # بلا بصمة الأصل الخام (ADR 0060): من يملك الأصل يطابقها فيعرف مصدر النسخة المسلَّمة
        manifest = {"schema": MANIFEST_SCHEMA, "license_id": license_id, "deliverables": status}
        sums: dict[str, str] = {}
        partial = out.with_name(out.name + ".partial")
        with zipfile.ZipFile(partial, "w") as zf:
            for name, path, stored in files:
                _add(zf, name, path, sums, stored=stored)
            _add(zf, "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode(),
                 sums, stored=False)
            _add(zf, "SHA256SUMS", "".join(f"{h}  {n}\n" for n, h in sums.items()).encode(), {}, stored=False)
        os.replace(partial, out)
        return manifest
    finally:
        for p in work.iterdir():
            p.unlink()
        work.rmdir()
