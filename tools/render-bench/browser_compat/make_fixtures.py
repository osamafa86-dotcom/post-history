"""مواد توافق المتصفحات: يولّد مصادر اصطناعية تحاكي الهواتف، ثم يمرّرها في كود العامل نفسه (`make_proxy` و`make_hls`)،
ويفحص المخرج بنيويًا مقابل قيود فك الترميز المشتركة في Chrome وFirefox وSafari:

- H.264 بملف Constrained Baseline أو Main أو High (لا High 10 ولا 4:2:2)، ومستوى ≤ 4.0، و`yuv420p` بثمانية بتات.
- AAC-LC.
- `moov` قبل `mdat` (faststart) في النسخة الخفيفة، كي يبدأ التشغيل قبل اكتمال التنزيل.
- مقاطع HLS بصيغة fMP4: `init.mp4` يحمل `avcC`، ونص `CODECS` محسوب منه.

يكتب `<out>/manifest.json` ويخرج بـ 1 إن خالف أي مخرج. يعمل داخل صورة workers/media:

    python make_fixtures.py /out
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

from media_worker.ffmpeg import FFMPEG, FFPROBE, run
from media_worker.hls import make_hls
from media_worker.probe import probe
from media_worker.proxy import make_proxy

SECONDS = 4
LAVFI = ["-f", "lavfi", "-i", f"testsrc2=size={{size}}:rate=30:duration={SECONDS}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SECONDS}"]
HLG = ["-x265-params", "log-level=error:pools=none:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
       "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"]
CASES = {
    # الاسم: (الحجم، إعدادات الترميز، دوران العرض)
    "sdr-1080p-vfr": ("1920x1080", ["-vf", "select='not(eq(mod(n,7),3))'", "-fps_mode", "vfr", "-c:v", "libx264",
                                    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-output_ts_offset", "2"], 0),
    "hlg-hevc-10bit": ("1920x1080", ["-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", *HLG], 0),
    "sdr-h264-10bit-422": ("1920x1080", ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv422p10le"], 0),
    "portrait-rotated": ("1920x1080", ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], 90),
    "uhd-4k-h264": ("3840x2160", ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], 0),
}
ALLOWED_PROFILES = {66: "baseline", 77: "main", 100: "high"}
MAX_LEVEL = 40


def boxes(data: bytes, start: int = 0, end: int | None = None):
    """صناديق ISO BMFF في المستوى الأعلى: (النوع، البداية، النهاية)."""
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
        elif size == 0:
            size = end - i
        yield kind.decode("latin-1"), i, i + size
        i += size


def avc_codec(data: bytes) -> tuple[str, int, int]:
    """`avc1.PPCCLL` من صندوق avcC (أول ظهور)، مع profile_idc وlevel_idc."""
    at = data.find(b"avcC")
    if at < 0:
        raise ValueError("no avcC box")
    profile, compat, level = data[at + 5], data[at + 6], data[at + 7]
    return f"avc1.{profile:02X}{compat:02X}{level:02X}", profile, level


def audio_profile(path: Path) -> str | None:
    out = run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,profile",
               "-of", "json", str(path)], timeout_s=30)
    streams = json.loads(out).get("streams") or []
    return f"{streams[0].get('codec_name')}:{streams[0].get('profile')}" if streams else None


def check(path: Path, data: bytes, faststart: bool) -> tuple[dict, list[str]]:
    codec, profile, level = avc_codec(data)
    info = probe(path) if faststart else None  # init.mp4 بلا عينات فلا مدة له
    problems = []
    if profile not in ALLOWED_PROFILES:
        problems.append(f"profile_idc {profile}")
    if level > MAX_LEVEL:
        problems.append(f"level_idc {level}")
    if info is not None and (info.bit_depth or 8) != 8:
        problems.append(f"bit depth {info.bit_depth}")
    audio = audio_profile(path)
    # init.mp4 بلا عينات فلا يقرأ ffprobe ملف AAC منه؛ المقاطع نسخ تيارات من النسخة الخفيفة التي فُحص ملفها
    if audio not in (None, "aac:LC") and not (audio == "aac:None" and not faststart):
        problems.append(f"audio {audio}")
    if faststart:
        order = [k for k, _, _ in boxes(data) if k in ("moov", "mdat")]
        if order[:1] != ["moov"]:
            problems.append("moov after mdat")
    return {"codecs": f"{codec}, mp4a.40.2" if audio else codec, "profile": ALLOWED_PROFILES.get(profile, profile),
            "level": level / 10}, problems


def main(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    manifest, failed = {}, False
    for name, (size, enc, rotation) in CASES.items():
        d = out / name
        d.mkdir(exist_ok=True)
        src = d / "source.mov"
        args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        args += [a.format(size=size) for a in LAVFI] + enc + ["-c:a", "aac", str(src)]
        run(args, timeout_s=300)
        if rotation:
            turned = d / "turned.mov"
            run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-display_rotation", str(rotation),
                 "-i", str(src), "-c", "copy", str(turned)], timeout_s=60)
            turned.replace(src)
        info = probe(src)
        proxy = make_proxy(src, d / "proxy.mp4", info)
        hls = make_hls(d / "proxy.mp4", d / "hls", proxy.duration_ms)
        src.unlink()
        proxy_facts, p1 = check(d / "proxy.mp4", (d / "proxy.mp4").read_bytes(), faststart=True)
        init_facts, p2 = check(d / "hls" / "init.mp4", (d / "hls" / "init.mp4").read_bytes(), faststart=False)
        manifest[name] = {
            "width": proxy.width, "height": proxy.height, "duration_ms": proxy.duration_ms,
            "proxy": proxy_facts, "hls": {**init_facts, "segments": sorted(p.name for p in hls if p.suffix == ".m4s")},
            "problems": p1 + [f"hls: {p}" for p in p2],
        }
        failed |= bool(p1 or p2)
        print(name, json.dumps(manifest[name], ensure_ascii=False))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
