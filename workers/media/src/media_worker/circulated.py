"""نسخة قالب «مواد متداولة» (ADR 0091): الأصل المتحقق كاملًا، من أول إطار إلى آخره، تحت طبقة القالب الشفافة.

- **الطبقة القصيرة:** Remotion يرسم الطبقة (`render/overlay.mjs`) بمعدل الناتج نفسه، لا المقطع كله. بعد الدخول (3.6 ث:
  آخر موجة تبدأ عند 1.2 ث وتعيش 2.4 ث) كل ما فيها دوري بدورة 0.6 ث، وهي عدد صحيح من الإطارات (18 عند 30، و15 عند 25).
  فتُرسم ثلاث قطع من خط زمن المقطع الكامل نفسه: الدخول، ودورة واحدة، والخروج (آخر 0.6 ث في موضعه الحقيقي)، ويكرر
  FFmpeg الدورة بينهما. الإطار f في الوسط هو إطار الدورة (f − الدخول) mod الدورة، وهو مطابق للرسم الكامل بالبصمة
  (يقيسه `tools/render-bench/circulated_bench.py`). المقطع الأقصر من القطع الثلاث يُرسم كاملًا.
- **الملاءمة:** إن اختلفت نسبة المصدر عن الإطار بأكثر من 1%: خلفية من الإطارات نفسها مكبّرة لتغطي الإطار ومموّهة بدقة
  الربع ومعتّمة، والمقدّمة كاملة بلا قص؛ مركزها عند y=580 في المخرج العمودي حين يكون المصدر أعرض من 1:1 (VT-08)، وفي
  الوسط فيما عدا ذلك. التكبير مسموح ولا يُولَّد محتوى.
- **اللون مطبَّع في FFmpeg لا متروك لنسخة المتصفح:** HDR إلى SDR بسلسلة النسخة الخفيفة نفسها، والنطاق الكامل (yuvj)
  إلى المحدود، ومصفوفة BT.601 إلى BT.709؛ والناتج `yuv420p` موسوم tv وBT.709. الطبقة موسومة BT.709 من Remotion.
- **الترميز:** H.264 High بـ CRF 19 وسقف 10 Mb/s (6 للمربع)، ومعدل 25 للمصدر 25 أو 50 وإلا 30، وAAC 48 kHz بقناتين على
  الأكثر (192 kb/s، و96 للأحادي)، والمصدر بلا صوت بلا صوت. بلا وسوم ولا فصول ولا SEI، و`bitexact` و`faststart`.
- الأصل يُقرأ فقط (`INPUT_GUARD`)، والمخرج باسم مؤقت ثم نقل ذري. المعاملات النصية لا تُسجَّل: تصل Remotion في ملف JSON
  بمجلد المهمة، وفشل الطبقة رمز لا نص.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import CHILD_ENV, FFMPEG, INPUT_GUARD, MediaToolError, run
from .probe import Probe, probe
from .proxy import TONEMAP

SIZES = {"vertical": (1080, 1920), "horizontal": (1920, 1080), "square": (1080, 1080)}
# السقف يحدّ الحجم (نحو 75 MB للدقيقة) والجودة من CRF؛ المربع 56% من البكسلات
RATE = {"vertical": ("10M", "20M"), "horizontal": ("10M", "20M"), "square": ("6M", "12M")}
CRF = "19"
# veryfast: الرسم كله (الطبقة والتركيب) ضمن مدة المصدر على 4 أنوية أقرب منه بـ medium، والجودة يقيسها VMAF على النسخة
# الضابطة (tools/render-bench/circulated_bench.py)؛ ADR 0091 البند 7 يجيز خفض الإعداد بالقياس
PRESET = "veryfast"
# مركز المقدّمة في المخرج العمودي لمصدر أعرض من 1:1 (VT-08)، كما في القالب (FG_CENTER_Y)
FG_CENTER_Y = 580
# تطابق النسبتين ضمن 1% = تحجيم وحده
ASPECT_TOLERANCE = 0.01
# الخلفية المموّهة: تُحسب بربع الدقة ثم تُكبَّر، وتُعتَّم كما في VT-08 (brightness 0.72)
BG_DIVISOR = 4
BG_SIGMA = 9
BG_DIM = 0.72
# توقيت الطبقة بالثواني (القالب): نهاية الدخول حتى تصير الطبقة دورية، والدورة، والخروج
INTRO_S = 3.6
PERIOD_S = 0.6
OUTRO_S = 0.6
# القالب لا يقصر المقطع عن 3 ث (calculateMetadata)
MIN_COMPOSITION_S = 3
BT601 = {"smpte170m": "bt601-6-525", "bt470bg": "bt601-6-625"}
# خصائص اللون على الإطارات نفسها: FFmpeg 8 يأخذ وسوم المرمّز من الإطار لا من خيارات سطر الأوامر وحدها
TAG_FRAMES = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
EXIT_TITLE_OVERFLOW = 3


class TitleOverflow(RuntimeError):
    """سطر لا يتّسع حتى بتصغير الكتلة إلى 70% (`title_overflow`)؛ نهائي، لا يُعاد."""


class OverlayError(RuntimeError):
    """فشل رسم الطبقة لسبب غير العنوان؛ مؤقت قد يكون نفاد ذاكرة، فيُعاد حتى حدّ المحاولات."""


@dataclass(frozen=True)
class RenderJob:
    """معاملات النسخة كما يعيدها الخادم (`MediaRenderJob`)؛ النصوص لا تُسجَّل."""
    render_id: str
    material_id: str
    source_file_id: str
    state: str
    template: str
    aspect: str
    title_lines: tuple[str, ...]
    location_text: str | None
    label: str

    @classmethod
    def from_api(cls, d: dict) -> RenderJob:
        return cls(render_id=d["render_id"], material_id=d["material_id"], source_file_id=d["source_file_id"],
                   state=d["state"], template=d["template"], aspect=d["aspect"],
                   title_lines=tuple(d["title_lines"]), location_text=d.get("location_text"), label=d["label"])

    def __repr__(self) -> str:  # لا نص في أي سجل أو استثناء
        return f"RenderJob(render_id={self.render_id!r}, aspect={self.aspect!r}, state={self.state!r})"


@dataclass(frozen=True)
class Piece:
    """قطعة من خط زمن الطبقة الكامل بإطارات شاملة الطرفين [first، last]."""
    first: int
    last: int

    @property
    def frames(self) -> int:
        return self.last - self.first + 1


@dataclass(frozen=True)
class OverlayPlan:
    fps: int
    frames: int  # إطارات الناتج، وهي إطارات الطبقة
    pieces: tuple[Piece, ...]  # قطعة واحدة (المقطع كله) أو الدخول والدورة والخروج

    @property
    def looped(self) -> bool:
        return len(self.pieces) == 3

    @property
    def fill(self) -> int:
        """إطارات الوسط التي تملؤها الدورة المكرّرة."""
        return self.frames - self.pieces[0].frames - self.pieces[2].frames if self.looped else 0

    @property
    def composition_frames(self) -> int:
        return max(self.frames, MIN_COMPOSITION_S * self.fps)


def output_fps(source: Probe) -> int:
    """25 إن كان المصدر 25 أو 50، وإلا 30، فلا يزيد على 30."""
    rate = source.avg_frame_rate or source.frame_rate or 30.0
    return 25 if any(abs(rate - r) < 0.5 for r in (25.0, 50.0)) else 30


def plan_overlay(duration_ms: int, fps: int) -> OverlayPlan:
    frames = max(1, round(duration_ms * fps / 1000))
    intro, period, outro = round(INTRO_S * fps), round(PERIOD_S * fps), round(OUTRO_S * fps)
    if frames <= intro + period + outro:
        return OverlayPlan(fps, frames, (Piece(0, frames - 1),))
    return OverlayPlan(fps, frames, (Piece(0, intro - 1), Piece(intro, intro + period - 1),
                                     Piece(frames - outro, frames - 1)))


def overlay_props(job: RenderJob, plan: OverlayPlan) -> dict:
    """معاملات القالب (ADR 0091 البند 3)؛ `reducedMotion` خطأ دائمًا، والخلفية شفافة."""
    return {
        "titleLines": list(job.title_lines),
        "location": job.location_text,
        "tag": job.label,
        "aspect": job.aspect,
        "fps": plan.fps,
        "background": "none",
        "reducedMotion": False,
        "durationInSeconds": plan.composition_frames / plan.fps,
    }


@dataclass(frozen=True)
class OverlayRenderer:
    """`node render/overlay.mjs` بحزمة القالب المجمّعة والمتصفح المثبّت في الصورة (هدف `render`)."""
    node: str
    script: Path
    bundle: Path
    browser: Path
    concurrency: int | None = None

    @classmethod
    def from_env(cls, env: dict[str, str]) -> OverlayRenderer:
        c = env.get("MEDIA_RENDER_CONCURRENCY")
        return cls(node=env.get("MEDIA_RENDER_NODE", "/opt/node/bin/node"),
                   script=Path(env.get("MEDIA_RENDER_SCRIPT", "/app/render/overlay.mjs")),
                   bundle=Path(env.get("MEDIA_RENDER_BUNDLE", "/app/render/bundle")),
                   browser=Path(env.get("MEDIA_RENDER_BROWSER", "/opt/chrome-headless-shell/chrome-headless-shell")),
                   concurrency=int(c) if c else None)

    def missing(self) -> list[str]:
        """ما ينقص الصورة لترسم؛ غيابه يمنع الإقلاع (يُغلق عند العطل، ولا تنزيل وقت التشغيل)."""
        return [str(p) for p in (Path(self.node), self.script, self.bundle, self.browser) if not p.exists()]

    def render(self, job: RenderJob, plan: OverlayPlan, workdir: Path, timeout_s: float) -> list[Path]:
        outs = [workdir / f"overlay-{i}.mov" for i in range(len(plan.pieces))]
        spec = workdir / "overlay.json"
        spec.write_text(json.dumps({
            "serveUrl": str(self.bundle), "browser": str(self.browser), "frames": plan.composition_frames,
            "concurrency": self.concurrency, "props": overlay_props(job, plan),
            "pieces": [{"from": p.first, "to": p.last, "out": str(o)} for p, o in zip(plan.pieces, outs)],
        }, ensure_ascii=False), encoding="utf-8")
        # بيئة العملية بلا أسرار العامل؛ HOME ومجلد Chromium المؤقت داخل مجلد المهمة
        env = {**CHILD_ENV, "HOME": str(workdir), "TMPDIR": str(workdir)}
        try:
            proc = subprocess.run([self.node, str(self.script), str(spec)], capture_output=True, timeout=timeout_s,
                                  check=False, env=env, cwd=workdir, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired as err:
            raise OverlayError(f"overlay timed out after {timeout_s:.0f}s") from err
        finally:
            spec.unlink(missing_ok=True)
        if proc.returncode == EXIT_TITLE_OVERFLOW:
            raise TitleOverflow("title_overflow")
        if proc.returncode != 0 or not all(o.exists() for o in outs):
            # السطر الأول وحده (رمز الفشل واسم الخطأ)، لا مخرج Remotion ولا Chromium
            first = proc.stderr.decode("utf-8", "replace").strip().splitlines()[:1]
            raise OverlayError(f"overlay exited {proc.returncode}: {first[0][:80] if first else ''}")
        return outs


def display_size(source: Probe) -> tuple[int, int]:
    w, h = source.width or 0, source.height or 0
    return (h, w) if source.rotation % 180 == 90 else (w, h)


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def fit(source: Probe, aspect: str) -> dict:
    """هندسة الملاءمة: تحجيم وحده عند تطابق النسبتين، وإلا مقدّمة كاملة فوق خلفية مموّهة."""
    W, H = SIZES[aspect]
    dw, dh = display_size(source)
    if not dw or not dh:
        raise ValueError("no video dimensions")
    src_ar, out_ar = dw / dh, W / H
    if abs(src_ar / out_ar - 1) <= ASPECT_TOLERANCE:
        return {"mode": "scale", "w": W, "h": H}
    if src_ar > out_ar:
        fw, fh = W, min(H, _even(W / src_ar))
    else:
        fw, fh = min(W, _even(H * src_ar)), H
    x = (W - fw) // 2
    if aspect == "vertical" and src_ar > 1:
        y = min(max(0, FG_CENTER_Y - fh // 2), H - fh)
    else:
        y = (H - fh) // 2
    return {"mode": "fill", "w": fw, "h": fh, "x": x - x % 2, "y": y - y % 2}


def color_chain(source: Probe) -> list[str]:
    """إلى `yuv420p` بنطاق tv وBT.709: HDR بخريطة النسخة الخفيفة، والنطاق الكامل والمصفوفة 601 بتحويل صريح."""
    if source.hdr:
        tin = source.color_transfer
        pin = source.color_primaries if source.color_primaries not in (None, "unknown") else "bt2020"
        min_ = source.color_space if source.color_space not in (None, "unknown") else "bt2020nc"
        return [f"zscale=tin={tin}:pin={pin}:min={min_}:t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
                f"tonemap=tonemap={TONEMAP}", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"]
    full = source.color_range == "pc" or (source.pix_fmt or "").startswith("yuvj")
    chain = [f"scale=in_range={'pc' if full else 'tv'}:out_range=tv", "format=yuv420p"]
    if source.color_space in BT601:
        # المصفوفة لا يحوّلها scale بين صيغتي YUV؛ مرشّح colorspace يحوّلها مع الأوليات والنقل
        chain.append(f"colorspace=all=bt709:iall={BT601[source.color_space]}:irange=tv:range=tv:format=yuv420p")
    return chain


def composite_graph(source: Probe, aspect: str, plan: OverlayPlan, overlay: bool = True) -> str:
    """`overlay=False` نسخة ضابطة بلا طبقة (الملاءمة والترميز نفسهما) لقياس الجودة وحده."""
    W, H = SIZES[aspect]
    fps, n = plan.fps, plan.frames
    # بداية الصورة عند صفر (يُكرَّر أول إطار إن تأخر عن الصوت)، وآخر إطار يُمدّ ثم يُقص، فالقاعدة n إطار بالضبط
    head = [f"fps={fps}:start_time=0", *color_chain(source), "tpad=stop_mode=clone:stop=-1", f"trim=end_frame={n}",
            f"setpts=N/{fps}/TB"]
    g = fit(source, aspect)
    if g["mode"] == "scale":
        graph = [f"[0:v:0]{','.join(head)},scale={W}:{H},setsar=1[base]"]
    else:
        bw, bh = W // BG_DIVISOR, H // BG_DIVISOR
        dim = f"16+(val-16)*{BG_DIM}"
        graph = [
            f"[0:v:0]{','.join(head)},split=2[bgsrc][fgsrc]",
            f"[bgsrc]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},gblur=sigma={BG_SIGMA},"
            f"scale={W}:{H},lutyuv=y='{dim}':u='128+(val-128)*{BG_DIM}':v='128+(val-128)*{BG_DIM}'[bg]",
            f"[fgsrc]scale={g['w']}:{g['h']},setsar=1[fg]",
            f"[bg][fg]overlay={g['x']}:{g['y']},setsar=1[base]",
        ]
    if not overlay:
        return ";".join(graph + [f"[base]format=yuv420p,{TAG_FRAMES}[v]"])
    # كل قطعة تُفكّ وتُحوَّل مرة واحدة، والدورة تُكرَّر من الذاكرة (loop) لا بفكّ ProRes من جديد لكل دورة
    if plan.looped:
        period = plan.pieces[1].frames
        graph += [f"[1:v]format=yuva420p[intro]",
                  f"[2:v]format=yuva420p,loop=loop=-1:size={period}:start=0,trim=end_frame={plan.fill},"
                  "setpts=PTS-STARTPTS[mid]",
                  "[3:v]format=yuva420p[outro]",
                  f"[intro][mid][outro]concat=n=3:v=1:a=0,setpts=N/{fps}/TB[ov]"]
    else:
        graph += [f"[1:v]format=yuva420p,setpts=N/{fps}/TB[ov]"]
    graph += [f"[base][ov]overlay=0:0:format=yuv420:eof_action=pass,format=yuv420p,{TAG_FRAMES}[v]"]
    return ";".join(graph)


def composite_args(src: Path, overlays: list[Path], dst: Path, source: Probe, aspect: str,
                   plan: OverlayPlan) -> list[str]:
    inputs = [*INPUT_GUARD, "-i", str(src)]
    # بلا طبقات: النسخة الضابطة للقياس
    for o in overlays:
        inputs += ["-i", str(o)]
    audio: list[str] = []
    if source.audio_codec:
        mono = (source.audio_channels or 2) == 1
        audio = ["-map", "0:a:0", "-c:a", "aac", "-b:a", "96k" if mono else "192k", "-ar", "48000",
                 "-ac", "1" if mono else "2", "-flags:a", "+bitexact"]
    maxrate, bufsize = RATE[aspect]
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *inputs,
        "-filter_complex", composite_graph(source, aspect, plan, overlay=bool(overlays)), "-map", "[v]", *audio,
        "-map_metadata", "-1", "-map_chapters", "-1", "-frames:v", str(plan.frames), "-r", str(plan.fps),
        "-c:v", "libx264", "-preset", PRESET, "-crf", CRF, "-maxrate", maxrate, "-bufsize", bufsize,
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        # رسالة SEI التي يكتبها المرمّز (اسمه وخياراته) تُحذف، و`bitexact` لا يكتب اسم الجامع ولا توقيتًا
        "-bsf:v", "filter_units=remove_types=6", "-fflags", "+bitexact", "-flags:v", "+bitexact",
        "-movflags", "+faststart", "-f", "mp4", str(dst),
    ]


def make_circulated(src: Path, dst: Path, source: Probe, job: RenderJob, renderer: OverlayRenderer,
                    workdir: Path) -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("render output must be a new file, never the original")
    if source.video_codec is None:
        raise ValueError("no video stream")
    if job.aspect not in SIZES:
        raise ValueError("unknown aspect")
    plan = plan_overlay(source.duration_ms, output_fps(source))
    seconds = source.duration_ms / 1000
    overlays = renderer.render(job, plan, workdir, timeout_s=max(600.0, sum(p.frames for p in plan.pieces) * 2.0))
    partial = dst.with_name(dst.name + ".partial")
    try:
        run(composite_args(src, overlays, partial, source, job.aspect, plan), max(600.0, seconds * 6),
            cwd=partial.parent)
        result = probe(partial)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
        for o in overlays:
            o.unlink(missing_ok=True)
    if result.width != SIZES[job.aspect][0] or result.height != SIZES[job.aspect][1]:
        raise MediaToolError("render has the wrong frame size")
    return result

