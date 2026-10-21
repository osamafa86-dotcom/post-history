"""تعديل محدود لصناديق ISO BMFF في ملف جديد ينتجه العامل: حذف مصفوفات SEI من `hvcC`.

x265 وبعض الهواتف تضع رسائل SEI (ومنها user_data_unregistered بنص حر) داخل `hvcC` في `moov`، ومرشح
`filter_units` لا يمس هذا الترويس. يُعاد بناء `moov` وحده بلا تلك المصفوفات، ولا يُمس `mdat`؛ لذلك يُشترط أن يأتي
`moov` بعد `mdat` (بلا faststart) فلا تتغير إزاحات العينات.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}
HEVC_SEI = {39, 40}
VISUAL_SAMPLE_ENTRY = 78  # حقول مدخل العينة المرئية قبل صناديقه الفرعية


def _boxes(data: bytes):
    i = 0
    while i + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        if size < 8 or i + size > len(data):
            raise ValueError("malformed box")
        yield kind, data[i + 8:i + size]
        i += size


def _box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def _hvcc(body: bytes) -> bytes:
    head, n, rest = body[:22], body[22], body[23:]
    arrays, i = [], 0
    for _ in range(n):
        nal_type = rest[i] & 0x3F
        count = struct.unpack(">H", rest[i + 1:i + 3])[0]
        j = i + 3
        for _ in range(count):
            j += 2 + struct.unpack(">H", rest[j:j + 2])[0]
        if nal_type not in HEVC_SEI:
            arrays.append(rest[i:j])
        i = j
    return head + bytes([len(arrays)]) + b"".join(arrays) + rest[i:]


def _walk(kind: bytes, body: bytes) -> bytes:
    if kind in CONTAINERS:
        return _box(kind, b"".join(_walk(k, b) for k, b in _boxes(body)))
    if kind == b"stsd":
        entries = []
        for k, entry in _boxes(body[8:]):
            if k in (b"hvc1", b"hev1"):
                fixed = entry[:VISUAL_SAMPLE_ENTRY]
                kids = b"".join(_box(c, _hvcc(b) if c == b"hvcC" else b)
                                for c, b in _boxes(entry[VISUAL_SAMPLE_ENTRY:]))
                entries.append(_box(k, fixed + kids))
            else:
                entries.append(_box(k, entry))
        return _box(kind, body[:8] + b"".join(entries))
    return _box(kind, body)


def strip_hvcc_sei(path: Path) -> None:
    """يعيد كتابة الملف ذريًا بلا مصفوفات SEI في `hvcC`. لا يُستدعى على الأصل أبدًا."""
    data = Path(path).read_bytes()
    top = list(_boxes(data))
    kinds = [k for k, _ in top]
    if b"moov" not in kinds or b"mdat" not in kinds or kinds.index(b"moov") < kinds.index(b"mdat"):
        raise ValueError("expected moov after mdat")
    partial = Path(path).with_name(Path(path).name + ".partial")
    partial.write_bytes(b"".join(_walk(k, b) if k == b"moov" else _box(k, b) for k, b in top))
    os.replace(partial, path)
