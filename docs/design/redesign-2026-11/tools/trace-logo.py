# يحوّل شعار الشبكة الأبيض (PNG) إلى SVG متّجه بلون واحد (currentColor) عبر potrace.
# الاستعمال: python3 -I tools/trace-logo.py brand/palpost-logo-white.png brand/palpost-logo.svg
import sys
import numpy as np
from PIL import Image
import potrace

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
alpha = np.array(im)[:, :, 3] > 128
h, w = alpha.shape
path = potrace.Bitmap(alpha).trace(turdsize=4, alphamax=1.0, opticurve=True, opttolerance=0.2)
parts = []
for curve in path:
    s = curve.start_point
    d = [f'M{s.x:.1f},{s.y:.1f}']
    for seg in curve.segments:
        if seg.is_corner:
            d.append(f'L{seg.c.x:.1f},{seg.c.y:.1f}L{seg.end_point.x:.1f},{seg.end_point.y:.1f}')
        else:
            d.append(f'C{seg.c1.x:.1f},{seg.c1.y:.1f} {seg.c2.x:.1f},{seg.c2.y:.1f} {seg.end_point.x:.1f},{seg.end_point.y:.1f}')
    parts.append(''.join(d) + 'Z')
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="Palestine Post">'
       f'<path fill="currentColor" fill-rule="evenodd" d="{"".join(parts)}"/></svg>\n')
open(dst, 'w').write(svg)
print(dst, w, h, len(path), 'curves', len(svg), 'bytes')
