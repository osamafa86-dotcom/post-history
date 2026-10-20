"""Download pinned weights and public corpora once, verifying sha256.

This is the only step of asr-bench that touches the network. The bench itself
runs offline (see bench.py). The first fetch of an unpinned file records its
revision and sha256 into models.lock.json with --pin; after that any mismatch
is fatal.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = HERE / "models.lock.json"
CACHE = Path(os.environ.get("ASR_BENCH_CACHE", Path.home() / ".cache" / "asr-bench"))


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def local_path(repo: str, revision: str, name: str) -> Path:
    return CACHE / "hub" / repo.replace("/", "__") / revision / name


def fetch_entry(lock: dict, key: str, entry: dict, pin: bool) -> None:
    from huggingface_hub import HfApi, hf_hub_download

    repo, rtype = entry["repo"], entry.get("repo_type", "model")
    pin_key = f"{rtype}:{repo}"
    # Pins are a list of {"file", "sha256"} records, so no file name sits next to its hash
    # on one line where a secret scanner reads "tokenizer.json": "<hex>" as a token.
    pins = lock["pins"].setdefault(pin_key, {"revision": None, "files": []})
    pinned = {p["file"]: p["sha256"] for p in pins["files"]}
    if pins["revision"] is None:
        if not pin:
            sys.exit(f"{repo}: not pinned; run once with --pin")
        pins["revision"] = HfApi().repo_info(repo, repo_type=rtype).sha
    revision = pins["revision"]
    for name in entry["files"]:
        dest = local_path(repo, revision, name)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            got = hf_hub_download(repo, name, repo_type=rtype, revision=revision, local_dir=dest.parent.parent / "_dl" / revision)
            os.replace(got, dest)
        digest = sha256_of(dest)
        want = pinned.get(name)
        if want is None:
            if not pin:
                sys.exit(f"{repo}/{name}: no sha256 pinned; run once with --pin")
            pins["files"].append({"file": name, "sha256": digest})
        elif want != digest:
            dest.unlink()
            sys.exit(f"{repo}/{name}: sha256 {digest} != pinned {want}; file removed")
        print(f"ok {key} {name} {digest[:12]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="model or corpus keys")
    ap.add_argument("--pin", action="store_true", help="record revision and sha256 of files not yet pinned")
    args = ap.parse_args()
    lock = json.loads(LOCK.read_text())
    entries = {**lock["models"], **lock["corpora"]}
    for key in args.only or entries:
        fetch_entry(lock, key, entries[key], args.pin)
        if args.pin:
            LOCK.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
