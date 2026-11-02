"""Synthetic background plates for the circulated-video template previews.

The plates are drawn here from scratch: a dusk gradient, a blocky skyline,
blurred "window" lights, a vignette and grain. No photo, footage or
third-party image is used, so the outputs carry no source or licence.

Usage (from the repository root):
    python3 docs/design/redesign-2026-11/tools/make-plates.py \
        docs/design/redesign-2026-11/motion/circulated-template/public/plates

Writes plate-9x16.jpg, plate-16x9.jpg and plate-1x1.jpg. Pillow only;
the output is deterministic for a given Pillow version (seeded RNG, no
system noise source), and Pillow writes no EXIF.
"""

import random
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

STOPS = [
    (0.00, (20, 28, 40)),
    (0.45, (44, 56, 70)),
    (0.62, (96, 84, 72)),
    (0.72, (60, 54, 52)),
    (1.00, (22, 22, 26)),
]
LIGHTS = [(255, 180, 100), (250, 140, 70), (255, 214, 160), (140, 190, 205)]


def sky(t: float) -> tuple[int, int, int]:
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if a <= t <= b:
            k = (t - a) / (b - a)
            return tuple(int(ca[j] + (cb[j] - ca[j]) * k) for j in range(3))
    return STOPS[-1][1]


def grain(w: int, h: int, rng: random.Random, sigma: float) -> Image.Image:
    """Seeded monochrome grain (Image.effect_noise is not seedable)."""
    data = bytes(max(0, min(255, int(128 + rng.gauss(0, sigma)))) for _ in range(w * h))
    return Image.frombytes("L", (w, h), data).convert("RGB")


def plate(w: int, h: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    s = min(w, h)
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=sky(y / h))

    skyline = Image.new("L", (w, h), 0)
    sd = ImageDraw.Draw(skyline)
    x, base = -20, int(h * 0.66)
    while x < w:
        bw = rng.randint(int(s * 0.05), int(s * 0.14))
        bh = rng.randint(int(s * 0.04), int(s * 0.2))
        sd.rectangle([x, base - bh, x + bw, h], fill=235)
        for _ in range(rng.randint(2, 6)):
            wx = rng.randint(x + 4, x + bw - 4)
            wy = rng.randint(base - bh + 6, base + int(s * 0.1))
            sd.rectangle([wx, wy, wx + int(s * 0.006), wy + int(s * 0.008)], fill=60)
        x += bw + rng.randint(-int(s * 0.01), int(s * 0.01))
    im.paste((16, 18, 22), mask=skyline)

    lights = Image.new("RGB", (w, h), (0, 0, 0))
    ld = ImageDraw.Draw(lights)
    for _ in range(140):
        r = rng.randint(int(s * 0.004), int(s * 0.02))
        cx, cy = rng.randint(0, w), rng.randint(int(h * 0.5), int(h * 0.9))
        ld.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rng.choice(LIGHTS))
    im = ImageChops.screen(im, lights.filter(ImageFilter.GaussianBlur(s * 0.004)))
    im = im.filter(ImageFilter.GaussianBlur(s * 0.012))

    vignette = Image.new("L", (w, h), 0)
    ImageDraw.Draw(vignette).ellipse([-w * 0.25, -h * 0.2, w * 1.25, h * 1.2], fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(s * 0.18))
    im = Image.composite(im, Image.new("RGB", (w, h), (6, 8, 12)), vignette)
    return Image.blend(im, grain(w, h, rng, 28), 0.05)


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    for name, (w, h) in {"plate-9x16.jpg": (1080, 1920), "plate-16x9.jpg": (1920, 1080), "plate-1x1.jpg": (1080, 1080)}.items():
        plate(w, h, seed=11).save(out / name, quality=88)
        print(out / name)


if __name__ == "__main__":
    main()
