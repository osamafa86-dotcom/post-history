"""بديل `render/overlay.mjs` في الاختبارات (صورة الاختبار بلا Node ولا متصفح): يقرأ ملف المهمة نفسه ويكتب لكل قطعة
ProRes 4444 شفافًا بعدد إطاراتها، فيه صندوق معتم بلون القطعة في الزاوية (الدخول أحمر، والدورة أخضر، والخروج أزرق).
العنوان «OVERFLOW» يخرج بالرمز 3 كما يفعل القالب، و«CRASH» يفشل بغيره."""

import json
import subprocess
import sys

SIZES = {"vertical": "1080x1920", "horizontal": "1920x1080", "square": "1080x1080"}
COLORS = ["red", "green", "blue"]

job = json.load(open(sys.argv[1], encoding="utf-8"))
props = job["props"]
if props["titleLines"][0] == "OVERFLOW":
    sys.stderr.write("title_overflow\n")
    sys.exit(3)
if props["titleLines"][0] == "CRASH":
    sys.stderr.write("overlay_failed Error\n")
    sys.exit(1)
assert props["background"] == "none" and props["reducedMotion"] is False
# القالب يصل overlay.mjs فيختار تركيبته من قائمة مغلقة (ADR 0109)
assert job["template"] in ("circulated", "witness")
assert round(props["durationInSeconds"] * props["fps"]) == job["frames"]
for i, piece in enumerate(job["pieces"]):
    n = piece["to"] - piece["from"] + 1
    color = COLORS[i] if len(job["pieces"]) == 3 else "red"
    size = SIZES[props["aspect"]]
    graph = (f"color=black@0:s={size}:r={props['fps']},format=yuva444p10le[t];"
             f"color={color}:s=120x120:r={props['fps']},format=yuva444p10le[b];[t][b]overlay=0:0,trim=end_frame={n}")
    subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-filter_complex", graph,
                    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                    piece["out"]], check=True)
