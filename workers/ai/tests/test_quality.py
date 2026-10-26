from fractions import Fraction

import numpy as np
import pytest

av = pytest.importorskip("av")
pytest.importorskip("cv2")

from ai_worker.quality import assess, dhash, jitter_px, read_signals, silences  # noqa: E402
from ai_worker.shots import Shot  # noqa: E402

W, H, FPS, SHOT_S = 320, 180, 24, 3.0
SR = 16000


def _clip(path, plan, silent=(4.0, 6.5)):
    """plan: لكل لقطة (رقم النسيج، الحركة: still أو shake أو pan). الصوت نغمة إلا مدى الصمت."""
    rng = np.random.default_rng(3)
    # نسيج منخفض التردد كالمشاهد الحقيقية: شبكة عشوائية مكبّرة، لا ضوضاء يمحوها الترميز
    grids = [rng.integers(0, 256, ((H + 40) // 20 + 1, (W + 40) // 20 + 1)) for _ in range(4)]
    textures = [np.kron(g, np.ones((20, 20)))[:H + 40, :W + 40].astype(np.uint8) for g in grids]
    textures = [np.stack([t] * 3, axis=-1) for t in textures]
    with av.open(str(path), "w", format="mp4") as c:
        v = c.add_stream("mpeg4", rate=FPS)
        v.width, v.height, v.pix_fmt, v.bit_rate = W, H, "yuv420p", 2_000_000
        v.codec_context.time_base = Fraction(1, 600)
        a = c.add_stream("aac", rate=SR)
        a.layout = "mono"
        n = 0
        for tex, move in plan:
            for k in range(int(SHOT_S * FPS)):
                ox, oy = 20, 20
                if move == "shake":
                    ox, oy = 20 + int(rng.integers(-6, 7)), 20 + int(rng.integers(-6, 7))
                elif move == "pan":
                    ox = 5 + k // 3
                img = textures[tex][oy:oy + H, ox:ox + W]
                f = av.VideoFrame.from_ndarray(np.ascontiguousarray(img), format="rgb24")
                f.pts, f.time_base = round(n * 600 / FPS), Fraction(1, 600)
                c.mux(v.encode(f))
                n += 1
        c.mux(v.encode(None))
        total = len(plan) * SHOT_S
        t = np.arange(int(total * SR)) / SR
        wave = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        wave[(t >= silent[0]) & (t < silent[1])] = 0.0
        for i in range(0, len(wave), 1024):
            fr = av.AudioFrame.from_ndarray(wave[None, i:i + 1024], format="flt", layout="mono")
            fr.sample_rate, fr.pts = SR, i
            c.mux(a.encode(fr))
        c.mux(a.encode(None))


def test_silences_need_the_minimum_length():
    levels = [-20.0] * 10 + [-60.0] * 30 + [-20.0] * 5 + [-60.0] * 10
    assert silences(levels, window_s=0.05, min_s=1.0) == [(0.5, 2.0)]


def test_smooth_pan_is_not_shake_but_jitter_is():
    pan = [(0.0, 0.0)] + [(1.0, 0.0)] * 60
    rng = np.random.default_rng(1)
    shake = [(0.0, 0.0)] + [(float(x), float(y)) for x, y in rng.integers(-3, 4, (60, 2))]
    assert jitter_px(pan, 24) < 0.1 and jitter_px(shake, 24) > 1.5


def test_dhash_is_stable_under_small_noise():
    rng = np.random.default_rng(2)
    img = rng.integers(0, 256, (90, 160)).astype(np.float32)
    noisy = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.float32)
    assert bin(dhash(img) ^ dhash(noisy)).count("1") <= 24


def test_clip_flags_shake_silence_and_the_repeated_shot(tmp_path):
    path = tmp_path / "q.mp4"
    _clip(path, [(0, "still"), (1, "shake"), (2, "pan"), (0, "still")])
    sig = read_signals(path)
    shots = [Shot(i * SHOT_S, (i + 1) * SHOT_S) for i in range(4)]
    q, quiet = assess(shots, sig, origin_s=sig.times[0])
    assert [s["shaky"] for s in q] == [False, True, False, False]
    assert [s["duplicate_of"] for s in q] == [None, None, None, 0]
    assert len(quiet) == 1 and abs(quiet[0][0] - 4.0) <= 0.15 and abs(quiet[0][1] - 6.5) <= 0.15
    assert q[1]["silent_ratio"] > 0.6 and q[0]["silent_ratio"] == 0.0
