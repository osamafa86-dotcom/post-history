"""كشف اللقطات على مقاطع اصطناعية حدودها معروفة، ومنها معدل متغير وبداية غير صفرية كما تسجّل الهواتف."""

import json
from fractions import Fraction

import numpy as np
import pytest

from ai_worker.captions import Segment
from ai_worker.shots import Shot, detect_shots, speech_segments, to_json

av = pytest.importorskip("av")
pytest.importorskip("scenedetect")
pytest.importorskip("cv2")

# ContentDetector averages the change in hue, saturation and brightness: shots differ in brightness as well as hue,
# as real cuts do (equal-brightness red to green scores about 20, under the default threshold of 27)
COLORS = [(90, 10, 10), (40, 230, 40), (30, 30, 160), (230, 220, 60)]


def clip(path, cuts_s, end_s, *, fps=30, vfr=False, start_s=0.0):
    """لون ثابت لكل لقطة مع ضجيج خفيف، والطوابع بقاعدة 1/600 (حد المرمّز mpeg4 دون 65536). vfr يجعل الفواصل بين الإطارات 1/24–1/40 ث."""
    rng = np.random.default_rng(1)
    with av.open(str(path), "w", format="mp4") as out:
        v = out.add_stream("mpeg4", rate=fps)
        v.width, v.height, v.pix_fmt = 160, 96, "yuv420p"
        v.codec_context.time_base = Fraction(1, 600)
        v.time_base = Fraction(1, 600)
        bounds = [0.0, *cuts_s, end_s]
        t = 0.0
        while t < end_s:
            shot = max(i for i, b in enumerate(bounds[:-1]) if t >= b)
            img = np.full((96, 160, 3), COLORS[shot % len(COLORS)], np.uint8)
            img = np.clip(img.astype(int) + rng.integers(-6, 7, img.shape), 0, 255).astype(np.uint8)
            f = av.VideoFrame.from_ndarray(img, format="rgb24")
            f.pts = round((t + start_s) * 600)
            f.time_base = Fraction(1, 600)
            out.mux(v.encode(f))
            t += (1 / rng.uniform(24, 40)) if vfr else 1 / fps
        out.mux(v.encode(None))
    return path


@pytest.mark.parametrize("vfr,start_s", [(False, 0.0), (True, 0.0), (True, 3.5)])
def test_cuts_land_on_the_real_frame_times(tmp_path, vfr, start_s):
    cuts = [2.0, 4.5, 6.2]
    shots, stats = detect_shots(clip(tmp_path / "c.mp4", cuts, 8.0, vfr=vfr, start_s=start_s))
    assert len(shots) == 4, shots
    found = [s.start for s in shots[1:]]
    # within two frames at the slowest rate of the clip (1/24 s), measured from the video start
    assert all(abs(f - c) <= 2 / 24 for f, c in zip(found, cuts)), (found, cuts)
    assert shots[0].start == 0.0 and abs(shots[-1].end - 8.0) <= 2 / 24
    assert stats["frames"] > 150


def test_origin_puts_shots_on_the_original_timeline(tmp_path):
    p = clip(tmp_path / "c.mp4", [2.0], 4.0, start_s=1.0)
    shots, _ = detect_shots(p, origin_s=0.0)  # the original's start_pts is 0; the proxy starts at 1 s
    assert abs(shots[0].start - 1.0) <= 2 / 30 and abs(shots[1].start - 3.0) <= 2 / 30


def test_a_single_static_shot_has_no_cut(tmp_path):
    shots, _ = detect_shots(clip(tmp_path / "c.mp4", [], 3.0))
    assert len(shots) == 1


def test_speech_segments_by_majority_overlap_and_json_carries_no_text():
    segs = [Segment(0.5, 1.5, " نص أول", ()), Segment(1.8, 3.0, " ", ()), Segment(1.9, 2.6, " نص ثانٍ", ())]
    shots = [Shot(0.0, 2.0), Shot(2.0, 4.0)]
    assert speech_segments(shots[0], segs) == [0]
    assert speech_segments(shots[1], segs) == [1]  # index 1 among non-empty segments: "نص ثانٍ"
    doc = to_json(shots, segs, source={"file_id": "f"}, stats={"frames": 120})
    assert "نص" not in doc
    d = json.loads(doc)
    assert d["status"] == "draft" and d["route"] == "local" and d["shots"][1]["speech_segments"] == [1]
