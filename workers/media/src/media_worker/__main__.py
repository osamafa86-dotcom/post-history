"""python -m media_worker serve (الخدمة) | requeue-dead REASON | reregister MID:FID… | {probe,digest,proxy} FILE [OUT] (للتجربة والقياس)"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from .hashing import digest_file
from .probe import probe
from .proxy import make_proxy


def main() -> None:
    parser = argparse.ArgumentParser(prog="media_worker")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    sub.add_parser("requeue-dead").add_argument("reason")
    sub.add_parser("reregister").add_argument("pairs", nargs="+", help="material_id:file_id")
    for name in ("probe", "digest"):
        sub.add_parser(name).add_argument("file", type=Path)
    p = sub.add_parser("proxy")
    p.add_argument("file", type=Path)
    p.add_argument("out", type=Path)
    args = parser.parse_args()

    if args.cmd == "requeue-dead":
        from .service import requeue_main

        requeue_main(args.reason)
        return
    if args.cmd == "reregister":
        from .reregister import main as reregister

        reregister(args.pairs)
        return
    if args.cmd == "serve":
        from .service import main as serve

        serve()
        return
    if args.cmd == "probe":
        out = probe(args.file).to_dict()
    elif args.cmd == "digest":
        out = asdict(digest_file(args.file))
    else:
        out = make_proxy(args.file, args.out).to_dict()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
