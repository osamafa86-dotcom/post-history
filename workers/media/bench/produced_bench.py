"""قياس النسخة المنتَجة `produced` (التصدير النهائي بلا محرر): زمن `render` للأصل كاملًا وزمن توقيع C2PA وحجم الناتج،
وغياب البيانات الكاشفة المزروعة، على مقاطع اصطناعية بصيغ الهواتف (H.264 1080p وHEVC 10 بت HLG).

الأصل يحمل وسوم حاوية (موقع وطراز جهاز) ووسوم تيار ورسالة SEI من المرمّز؛ يُحكم على الناتج بغيابها كلها. التوقيع
بسلسلة اختبار من openssl (يثبت الصياغة لا الثقة). لا ملف حقيقي ولا اتصال خارجي. المخرج بمخطط
contracts/schemas/measurement.json.

    python bench/produced_bench.py --out /results/<date>-produced-render.json [--seconds 60]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from preview_slo import PROFILES  # noqa: E402

from media_worker import c2pa, ffmpeg  # noqa: E402
from media_worker.ffmpeg import FFMPEG, run  # noqa: E402
from media_worker.probe import probe  # noqa: E402
from media_worker.render import Segment, render  # noqa: E402

# قيم غير واقعية عمدًا كما في أدوات القبول
PLANTED = {"com.apple.quicktime.location.ISO6709": "+00.0001+000.0001+000.000/",
           "com.apple.quicktime.make": "BenchMaker", "com.apple.quicktime.model": "BenchPhone 1"}
STREAM = {"comment": "bench-device-serial-0000"}
CASES = ("1080p-h264", "1080p-hlg")


def make_clip(path: Path, profile: str, seconds: int) -> list[bytes]:
    size, video = PROFILES[profile]
    tags = [a for k, v in PLANTED.items() for a in ("-metadata", f"{k}={v}")]
    stream = [a for k, v in STREAM.items() for a in ("-metadata:s:v:0", f"{k}={v}")]
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
         *video, "-c:a", "aac", "-b:a", "128k", "-movflags", "use_metadata_tags", *tags, *stream, str(path)],
        timeout_s=seconds * 60)
    marker = b"x265 (build" if "hlg" in profile else b"x264 - core"
    return [v.encode() for v in [*PLANTED.values(), *STREAM.values()]] + [marker]


def chain(d: Path) -> c2pa.Signer:
    def ossl(*a: str) -> None:
        subprocess.run(["openssl", *a], cwd=d, check=True, capture_output=True)
    ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key")
    ossl("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=Bench Root",
         "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
         "-out", "ca.pem")
    ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.ec")
    ossl("pkcs8", "-topk8", "-nocrypt", "-in", "leaf.ec", "-out", "leaf.key")
    ossl("req", "-new", "-key", "leaf.ec", "-subj", "/CN=Bench Signer", "-out", "leaf.csr")
    (d / "ext.cnf").write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                               "extendedKeyUsage=emailProtection\nsubjectKeyIdentifier=hash\n"
                               "authorityKeyIdentifier=keyid\n")
    ossl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
         "-sha256", "-extfile", "ext.cnf", "-out", "leaf.pem")
    (d / "chain.pem").write_text((d / "leaf.pem").read_text() + (d / "ca.pem").read_text())
    return c2pa.Signer(cert_chain=d / "chain.pem", private_key=d / "leaf.key", trust_anchors=d / "ca.pem")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    started, metrics, leaks = now(), {}, 0
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "certs").mkdir()
        signer = chain(d / "certs")
        for case in CASES:
            src = d / f"{case}.mov"
            planted = make_clip(src, case, args.seconds)
            info = probe(src)
            built, signed = d / f"{case}-produced.mp4", d / f"{case}-signed.mp4"
            t = time.perf_counter()
            made = render(src, built, info, [Segment(info.start_pts_us, info.start_pts_us + info.duration_ms * 1000)])
            render_s = time.perf_counter() - t
            t = time.perf_counter()
            source = c2pa.source_ref(b"bench-only-c2pa-source-secret-0123456789", "0" * 64)
            c2pa.sign(built, signed, signer=signer, title=signed.name, source=source,
                      actions=["c2pa.transcoded"] + (["c2pa.color_adjustments"] if info.hdr else []),
                      publisher="Bench Network", version="1")
            sign_s = time.perf_counter() - t
            blob = signed.read_bytes()
            found = sum(1 for v in planted if v in blob)
            leaks += found
            metrics.update({
                f"{case}_render_s": round(render_s, 2), f"{case}_sign_s": round(sign_s, 2),
                f"{case}_render_x_realtime": round(render_s / args.seconds, 3),
                f"{case}_source_bytes": src.stat().st_size, f"{case}_produced_bytes": len(blob),
                f"{case}_produced_height": made.height, f"{case}_produced_hdr": made.hdr,
                f"{case}_planted_values_found": found,
            })
            print(case, {k: v for k, v in metrics.items() if k.startswith(case)})
    result = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-produced-render",
        "started_at": started, "ended_at": now(),
        # الناتج اصطناعي والتوقيع بسلسلة اختبار؛ لا ثقة حقيقية ولا ملف هاتف حقيقي
        "result": "partial" if leaks == 0 else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(args.seconds), "codec": "h264+hevc", "vfr": False, "hdr": True},
        "metrics": {**metrics, "planted_values_found_total": leaks, "encoder": "libx264 CRF 18",
                    "ffmpeg_version": ffmpeg.version()},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    return 0 if leaks == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
