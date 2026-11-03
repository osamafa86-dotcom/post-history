"""نسخة قالب «مواد متداولة» (ADR 0091) و«الشاهد» (ADR 0109): التخطيط والملاءمة واللون، والتركيب فوق طبقة بديلة، ومهمة
الطابور."""

from __future__ import annotations

import hashlib
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, STREAM_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import ApiConflict, FileRef, Session
from media_worker.circulated import (WITNESS, OverlayError, OverlayRenderer, RenderJob, TitleOverflow, color_chain, fit,
                                     make_circulated, output_fps, overlay_props, plan_overlay, template_of)
from media_worker.ffmpeg import FFMPEG, run
from media_worker.jobs import Buckets, Jobs, ScratchFull, circulated_key
from media_worker.probe import Probe, probe

MID = "4a000000-0000-4000-8000-000000000091"
RID = "7e000000-0000-4000-8000-000000000091"
TITLE = "سطر تجريبي محايد"
FAKE = OverlayRenderer(node=sys.executable, script=Path(__file__).with_name("fake_overlay.py"),
                       bundle=Path("/nonexistent-bundle"), browser=Path("/nonexistent-browser"))


def _probe(**over) -> Probe:
    base = dict(duration_ms=10_000, start_pts_us=0, container="mov", video_codec="h264", audio_codec="aac",
                width=1920, height=1080, frame_rate=30.0, avg_frame_rate=30.0, vfr=False, frame_count=300,
                max_frame_gap_ms=33.4, has_gaps=False, rotation=0, hdr=False, bit_depth=8, audio_sample_rate=48000,
                audio_channels=2)
    return Probe(**{**base, **over})


def _job(**over) -> RenderJob:
    d = dict(render_id=RID, material_id=MID, source_file_id=FakeApi.FILE_ID, state="requested",
             template="circulated", aspect="vertical", title_lines=[TITLE], location_text="مدينة، محافظة",
             label="circulated_footage")
    return RenderJob.from_api({**d, **over})


def test_output_rate_is_25_for_25_or_50_and_30_otherwise():
    for rate, want in ((25.0, 25), (50.0, 25), (24.97, 25), (29.97, 30), (30.0, 30), (60.0, 30), (24.0, 30)):
        assert output_fps(_probe(avg_frame_rate=rate)) == want


def test_overlay_plan_renders_intro_one_cycle_and_the_real_ending():
    p = plan_overlay(30_000, 30)
    assert [(x.first, x.last) for x in p.pieces] == [(0, 107), (108, 125), (882, 899)]
    assert p.frames == 900 and p.fill == 900 - 108 - 18
    p25 = plan_overlay(30_000, 25)
    assert [(x.first, x.last) for x in p25.pieces] == [(0, 89), (90, 104), (735, 749)]
    # أقصر من القطع الثلاث: يُرسم كاملًا، والتركيبة لا تقصر عن 3 ث
    short = plan_overlay(2_000, 30)
    assert [(x.first, x.last) for x in short.pieces] == [(0, 59)] and short.composition_frames == 90


def test_witness_plan_has_its_own_intro_cycle_and_shortest_composition():
    """«الشاهد» (ADR 0109): دخول 4.8 ث (البصمة دورية من 4.04 ث مقيسةً)، ودورة 1.2 ث، وخروج 0.6 ث، وتركيبة ≥ 4 ث."""
    assert template_of("witness") is WITNESS and template_of("circulated").name == "circulated"
    with pytest.raises(ValueError):
        template_of("urgent")
    p = plan_overlay(30_000, 30, WITNESS)
    assert [(x.first, x.last) for x in p.pieces] == [(0, 143), (144, 179), (882, 899)]
    assert p.fill == 900 - 144 - 18 and p.composition_frames == 900
    p25 = plan_overlay(30_000, 25, WITNESS)
    assert [(x.first, x.last) for x in p25.pieces] == [(0, 119), (120, 149), (735, 749)]
    # أقصر من القطع الثلاث (198 إطارًا عند 30): يُرسم كاملًا، والتركيبة لا تقصر عن 4 ث
    short = plan_overlay(6_500, 30, WITNESS)
    assert [(x.first, x.last) for x in short.pieces] == [(0, 194)] and short.composition_frames == 195
    assert plan_overlay(2_000, 25, WITNESS).composition_frames == 100
    # المعاملات نفسها للقالبين: القالب يختار التركيبة، والتاريخ والحساب لا يمرّان من العامل أصلًا
    props = overlay_props(_job(template="witness"), p25)
    assert props == overlay_props(_job(), p25) and not {"date", "credit"} & set(props)


def test_props_follow_the_contract_names_and_never_reduce_motion():
    props = overlay_props(_job(location_text=None, label="none", aspect="square"), plan_overlay(10_000, 25))
    assert props == {"titleLines": [TITLE], "location": None, "tag": "none", "aspect": "square", "fps": 25,
                     "background": "none", "reducedMotion": False, "durationInSeconds": 10.0}
    assert TITLE not in repr(_job()) and "مدينة" not in repr(_job())


def test_fit_places_a_wide_source_at_580_in_vertical_and_centres_otherwise():
    assert fit(_probe(), "vertical") == {"mode": "fill", "w": 1080, "h": 608, "x": 0, "y": 276}
    assert fit(_probe(), "horizontal") == {"mode": "scale", "w": 1920, "h": 1080}
    assert fit(_probe(width=1280, height=720, rotation=90), "vertical") == {"mode": "scale", "w": 1080, "h": 1920}
    sq = fit(_probe(width=720, height=720), "vertical")
    assert sq["mode"] == "fill" and sq["w"] == 1080 and sq["y"] == (1920 - 1080) // 2
    four_three = fit(_probe(width=640, height=480), "horizontal")
    assert four_three == {"mode": "fill", "w": 1440, "h": 1080, "x": 240, "y": 0}
    # ضمن 1%: تحجيم وحده
    assert fit(_probe(width=1080, height=1912), "vertical")["mode"] == "scale"


def test_colour_chain_normalises_range_matrix_and_hdr():
    assert color_chain(_probe(pix_fmt="yuvj420p"))[0] == "scale=in_range=pc:out_range=tv"
    assert color_chain(_probe(color_range="tv"))[0] == "scale=in_range=tv:out_range=tv"
    assert any(f.startswith("colorspace=all=bt709:iall=bt601-6-625") for f in color_chain(_probe(color_space="bt470bg")))
    hdr = color_chain(_probe(hdr=True, color_transfer="arib-std-b67"))
    assert hdr[0].startswith("zscale=tin=arib-std-b67") and hdr[-2:] == ["zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"]


@pytest.fixture(scope="module")
def wide_clip(tmp_path_factory) -> Path:
    """1280x720 بنطاق كامل (yuvj420p كتسجيلات الشاشة) ووسوم كاشفة، 6 ث بصوت أحادي."""
    d = tmp_path_factory.mktemp("circ")
    plain = synth(d / "plain.mov", seconds=6, size="1280x720", leaky_tags=True, stream_tags=True)
    out = d / "full-range.mov"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(plain), "-map", "0",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuvj420p", "-color_range", "pc",
         "-c:a", "aac", "-ac", "1", "-map_metadata", "0", "-movflags", "use_metadata_tags",
         # منطقة بيضاء ناصعة (255 بنطاق كامل) أعلى اليسار لقياس تحويل النطاق
         "-vf", "drawbox=x=0:y=0:w=320:h=180:color=white:t=fill", str(out)], timeout_s=120)
    return out


def _luma(path: Path, at: float, crop: str) -> float:
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", str(at), "-i", str(path),
               "-frames:v", "1", "-vf", f"crop={crop},extractplanes=y", "-f", "rawvideo", "-"], timeout_s=60)
    return sum(raw) / len(raw)  # قيم Y الخام بلا تحويل نطاق


def _rgb(path: Path, frame: int, crop: str) -> tuple[float, float, float]:
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
               "-vf", f"select=eq(n\\,{frame}),crop={crop},format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"],
              timeout_s=60)
    n = len(raw) // 3
    return tuple(sum(raw[i::3]) / n for i in range(3))  # type: ignore[return-value]


def test_composite_is_tagless_bt709_tv_with_the_overlay_cycle_and_ending(wide_clip: Path, tmp_path: Path):
    info = probe(wide_clip)
    out = tmp_path / "out.mp4"
    made = make_circulated(wide_clip, out, info, _job(), FAKE, tmp_path)
    s = run([FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries",
             "stream=codec_name,profile,pix_fmt,color_range,color_space,color_primaries,color_transfer,r_frame_rate,"
             "nb_frames,sample_rate,channels", "-of", "compact", str(out)], timeout_s=60).decode()
    assert "pix_fmt=yuv420p|color_range=tv|color_space=bt709|color_transfer=bt709|color_primaries=bt709" in s
    assert "profile=High" in s and "r_frame_rate=30/1|nb_frames=180" in s
    assert "sample_rate=48000|channels=1" in s
    assert (made.width, made.height, made.frame_count) == (1080, 1920, 180)
    # بلا وسوم ولا اسم المرمّز
    blob = out.read_bytes()
    for value in [*LEAKY_TAGS.values(), *STREAM_TAGS.values(), "x264 - core", "Lavf"]:
        assert value.encode() not in blob
    # النطاق الكامل صار محدودًا: الأبيض الناصع 255 ← 235 في المقدّمة (أعلى يسار المصدر عند y=276)
    assert 228 <= _luma(out, 1.0, "200:80:20:300") <= 240
    # الطبقة: الدخول (أحمر) ثم الدورة المكرّرة (أخضر) في الوسط ثم الخروج الحقيقي (أزرق) في آخر 0.6 ث
    r, g, b = _rgb(out, 30, "100:100:10:10")
    assert r > 180 and g < 80 and b < 80
    r, g, b = _rgb(out, 140, "100:100:10:10")
    assert g > 100 and r < 80 and b < 80
    r, g, b = _rgb(out, 175, "100:100:10:10")
    assert b > 180 and r < 80 and g < 80
    # الأصل لم يُمس
    assert probe(wide_clip) == info


def test_overlay_failures_map_to_codes(wide_clip: Path, tmp_path: Path):
    info = probe(wide_clip)
    with pytest.raises(TitleOverflow):
        make_circulated(wide_clip, tmp_path / "o.mp4", info, _job(title_lines=["OVERFLOW"]), FAKE, tmp_path)
    with pytest.raises(OverlayError) as err:
        make_circulated(wide_clip, tmp_path / "o.mp4", info, _job(title_lines=["CRASH"]), FAKE, tmp_path)
    assert TITLE not in str(err.value)
    assert not (tmp_path / "o.mp4").exists() and not list(tmp_path.glob("overlay*"))


class RenderApi(FakeApi):
    def __init__(self, session: Session, render: dict) -> None:
        super().__init__(session)
        self.render = render
        self.calls: list[str] = []

    def get_render(self, render_id: str) -> dict:
        assert render_id == self.render["render_id"]
        return dict(self.render)

    def start_render(self, render_id: str) -> None:
        self.calls.append("start")
        if self.render["state"] in ("ready", "failed"):
            raise ApiConflict("409")
        self.render["state"] = "rendering"

    def fail_render(self, render_id: str, reason: str) -> None:
        self.calls.append(f"fail:{reason}")
        if self.render["state"] == "ready":
            raise ApiConflict("409")
        self.render["state"] = "failed"


def _render_setup(data: bytes, tmp_path: Path, **render):
    storage = FakeStorage()
    storage.objects[("uploads", "orig/91")] = data
    api = RenderApi(Session(id="5e000000-0000-4000-8000-000000000091", material_id=MID, kind="original",
                            state="verified", size_bytes=len(data), storage_key="orig/91", material_has_proxy=True),
                    {"render_id": RID, "material_id": MID, "source_file_id": FakeApi.FILE_ID, "state": "requested",
                     "template": "circulated", "aspect": "square", "title_lines": [TITLE], "location_text": None,
                     "label": "none", **render})
    api.original = FileRef(file_id=FakeApi.FILE_ID, material_id=MID, storage_key="orig/91", size_bytes=len(data),
                           sha256=hashlib.sha256(data).hexdigest())
    jobs = Jobs(api, storage, Buckets(uploads="uploads", derived="media"), tmp_path, enable_renders=True, renderer=FAKE)
    jobs.render_scratch_margin = 0  # لا تتبع الاختبارات قرص المضيف؛ الميزانية نفسها في الاختبار التالي
    return api, storage, jobs


def _requested() -> dict:
    return {"type": "render.requested", "aggregate_type": "material",
            "payload": {"material_id": MID, "render_id": RID, "source_file_id": FakeApi.FILE_ID,
                        "requested_by": "0e000000-0000-4000-8000-000000000001"}}


def test_render_job_starts_builds_and_registers_per_render(wide_clip: Path, tmp_path: Path):
    api, storage, jobs = _render_setup(wide_clip.read_bytes(), tmp_path)
    assert jobs.handle(_requested()) == "render"
    assert api.calls == ["start"]
    (fid, body), = api.derivatives
    key = circulated_key(_job(aspect="square"))
    assert fid == FakeApi.FILE_ID and key == f"derived/{MID}/{FakeApi.FILE_ID}/renders/{RID}/circulated-square.mp4"
    assert body["kind"] == "circulated_render" and body["render_id"] == RID and body["mime_type"] == "video/mp4"
    assert body["storage_key"] == key and body["sha256"] == hashlib.sha256(storage.objects[("media", key)]).hexdigest()
    assert (body["technical"]["width"], body["technical"]["height"]) == (1080, 1080)
    assert not list(tmp_path.glob("job-*"))
    # إعادة التسليم بعد الرفع: تُسجَّل المرفوعة كما هي بلا رسم جديد
    api.render["state"] = "rendering"
    jobs.renderer = replace(FAKE, script=Path("/nonexistent-script"))
    assert jobs.handle(_requested()) == "render-existing"
    assert api.derivatives[1][1]["sha256"] == body["sha256"]


def test_witness_render_job_writes_its_own_file_name(wide_clip: Path, tmp_path: Path):
    api, storage, jobs = _render_setup(wide_clip.read_bytes(), tmp_path, template="witness")
    assert jobs.handle(_requested()) == "render"
    (fid, body), = api.derivatives
    key = f"derived/{MID}/{FakeApi.FILE_ID}/renders/{RID}/witness-square.mp4"
    assert circulated_key(_job(template="witness", aspect="square")) == key
    # النوع نفسه (`circulated_render`)، والقالب يغيّر اسم الملف وحده
    assert body["kind"] == "circulated_render" and body["storage_key"] == key and ("media", key) in storage.objects
    assert (body["technical"]["width"], body["technical"]["height"]) == (1080, 1080)
    # قالب لا تعرفه الصورة: فشل نهائي بلا التقاط
    api, _, jobs = _render_setup(wide_clip.read_bytes(), tmp_path, template="urgent")
    assert jobs.handle(_requested()) == "render-failed:render_failed"
    assert api.calls == ["fail:render_failed"] and not api.derivatives


def test_render_job_codes_its_permanent_failures(wide_clip: Path, tmp_path: Path):
    data = wide_clip.read_bytes()
    api, _, jobs = _render_setup(data, tmp_path, title_lines=["OVERFLOW"])
    assert jobs.handle(_requested()) == "render-failed:title_overflow"
    assert api.calls == ["start", "fail:title_overflow"] and not api.derivatives
    api, _, jobs = _render_setup(data, tmp_path)
    api.original = replace(api.original, sha256="0" * 64)
    assert jobs.handle(_requested()) == "render-failed:source_unavailable"
    # الجاهزة أو الفاشلة تُتجاوز بلا التقاط
    api, _, jobs = _render_setup(data, tmp_path, state="ready")
    assert jobs.handle(_requested()) == "render-skip:ready" and api.calls == []
    # ما يبقى بعد المحاولات render_failed، والجاهزة لا يقلبها فشل
    api, _, jobs = _render_setup(data, tmp_path)
    assert jobs.report_failure(_requested(), "storage_error") == "reported:failed"
    assert api.calls == ["fail:render_failed"]
    api.render["state"] = "ready"
    assert jobs.report_failure(_requested(), "storage_error") == "already-decided"


def test_render_job_waits_for_scratch_and_stays_off_behind_the_flag(wide_clip: Path, tmp_path: Path, monkeypatch):
    api, _, jobs = _render_setup(wide_clip.read_bytes(), tmp_path)
    import media_worker.jobs as jobs_mod

    monkeypatch.setattr(jobs_mod.shutil, "disk_usage", lambda _p: type("U", (), {"free": 1024})())
    with pytest.raises(ScratchFull):
        jobs.handle(_requested())
    assert api.calls == []
    jobs.enable_renders = False
    assert jobs.handle(_requested()) == "ignored"
