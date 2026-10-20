#!/usr/bin/env python3
"""تنزيل أوزان المسار المحلي مرة واحدة بالبصمة (ADR 0019). يعمل في حاوية ai-models وحدها (شبكة لها خروج)، ثم تعمل
حاوية ai-worker على شبكة داخلية بلا خروج وتقرأ الحجم للقراءة فقط. مكتبة بايثون القياسية فقط.

  python3 fetch_models.py --lock models.lock --dest /models [--models ggml-tiny,...] [--offline]

لكل نموذج: إن وُجد الملف بالحجم والبصمة المثبّتين فلا تنزيل. وإلا يُنزَّل إلى .part مع حساب البصمة أثناء التنزيل، ولا
يُعاد تسميته إلا إن طابق الحجم والبصمة، وإلا يُحذف ويخرج بخطأ. ملف موجود لا يطابق يُعاد تنزيله ولا يُستعمل.
--offline: تحقق فقط بلا شبكة (الخروج 1 إن نقص نموذج أو لم يطابق). يكتب MANIFEST بالأسماء والبصمات المتحقق منها.
"""
import argparse
import hashlib
import os
import sys
import urllib.request

CHUNK = 1 << 20


def read_lock(path):
    """{model: [(file, size, sha256, url), ...]}: نموذج من ملف واحد (ggml) أو عدة ملفات (faster-whisper)."""
    models = {}
    with open(path) as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            model, rel, size, sha, url = line.split()
            if rel.startswith("/") or ".." in rel.split("/"):
                raise ValueError(f"unsafe path in lock: {rel}")
            models.setdefault(model, []).append((rel, int(size), sha.lower(), url))
    return models


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def verified(path, size, sha):
    return os.path.isfile(path) and os.path.getsize(path) == size and file_sha256(path) == sha


def download(url, part, size, sha):
    h, got = hashlib.sha256(), 0
    req = urllib.request.Request(url, headers={"User-Agent": "post-history-ai-models/1"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as out:
        for block in iter(lambda: resp.read(CHUNK), b""):
            got += len(block)
            if got > size:
                raise ValueError(f"larger than the pinned {size} bytes")
            h.update(block)
            out.write(block)
    if got != size:
        raise ValueError(f"{got} bytes, pinned {size}")
    if h.hexdigest() != sha:
        raise ValueError("sha256 does not match the pinned value")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lock", required=True)
    ap.add_argument("--dest", required=True)
    ap.add_argument("--models", default=os.environ.get("AI_MODELS", ""))
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()

    lock = read_lock(a.lock)
    wanted = [m.strip() for m in a.models.split(",") if m.strip()]
    if not wanted:
        sys.exit("no models requested (AI_MODELS or --models)")
    unknown = [m for m in wanted if m not in lock]
    if unknown:
        sys.exit(f"not in {a.lock}: {', '.join(unknown)}")

    failed = []
    for name in wanted:
        for rel, size, sha, url in lock[name]:
            path = os.path.join(a.dest, rel)
            if verified(path, size, sha):
                print(f"present  {name} {rel} ({size} bytes, sha256 ok)", flush=True)
                continue
            if a.offline:
                print(f"MISSING  {name} {rel}: absent or not matching the pin", flush=True)
                failed.append(name)
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            part = path + ".part"
            try:
                print(f"fetching {name} {rel} ({size} bytes)", flush=True)
                download(url, part, size, sha)
                os.replace(part, path)
                os.chmod(path, 0o444)
                print(f"verified {name} {rel}", flush=True)
            except Exception as err:  # الشبكة أو عدم المطابقة: لا يبقى ملف جزئي ولا يُستعمل نموذج غير مطابق
                if os.path.exists(part):
                    os.remove(part)
                print(f"FAILED   {name}: {err}", flush=True)
                failed.append(name)

    ok = [m for m in wanted if m not in failed]
    with open(os.path.join(a.dest, "MANIFEST.part"), "w") as fh:
        fh.writelines(f"{m} {rel} {sha}\n" for m in ok for rel, _, sha, _ in lock[m])
    os.replace(os.path.join(a.dest, "MANIFEST.part"), os.path.join(a.dest, "MANIFEST"))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
