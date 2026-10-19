"""تشغيل ffmpeg/ffprobe بقائمة وسائط (لا shell) ومهلة. المسار من البيئة ليطابق الإصدار المثبّت في الصورة."""

from __future__ import annotations

import os
import subprocess
from collections.abc import Sequence

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")

# الملفات من المراسلين غير موثوقة: يُقبل من الحاويات ما تنتجه الهواتف والكاميرات فقط، ولا بروتوكول غير الملف المحلي.
# قائمة HLS أو concat متنكرة بامتداد .mp4 تستطيع وإلا أن تقرأ ملفات العامل (/proc/self/environ) وتضمّنها في المخرج.
ALLOWED_DEMUXERS = ("mov", "matroska", "mpegts", "aac", "wav", "ogg", "mp3")
INPUT_GUARD = ["-format_whitelist", ",".join(ALLOWED_DEMUXERS), "-protocol_whitelist", "file"]
# العملية الفرعية لا ترث بيئة العامل (رمز الخادم، مفاتيح التخزين)
CHILD_ENV = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LC_ALL": "C"}


class MediaToolError(RuntimeError):
    """فشل ffmpeg/ffprobe. الرسالة تحمل ذيل stderr فقط؛ لا تُسجَّل في قنوات خارجية لأنها قد تحمل مسارات."""


def run(args: Sequence[str], timeout_s: float) -> bytes:
    try:
        proc = subprocess.run(list(args), capture_output=True, timeout=timeout_s, check=False, env=CHILD_ENV)
    except subprocess.TimeoutExpired as err:
        raise MediaToolError(f"{args[0]} timed out after {timeout_s:.0f}s") from err
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise MediaToolError(f"{os.path.basename(args[0])} exited {proc.returncode}: {' | '.join(tail)}")
    return proc.stdout


def version() -> str:
    first = run([FFMPEG, "-hide_banner", "-version"], timeout_s=10).decode().splitlines()[0]
    return first.split()[2]
