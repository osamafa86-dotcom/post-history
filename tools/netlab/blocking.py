#!/usr/bin/env python3
"""محاكاة الحجب لنطاق ingest. غير المُوكَّل (ADR 0011، SEC-07): ما الذي يبقى يعمل حين يُحجب النطاق الرئيسي.

ثلاث نقاط رفع: main (app.example على العنوان A، يمثّل النطاق خلف Cloudflare)، وingest (ingest.example على العنوان
المستقل B، برمز الرفع القصير)، وingest_shared (نطاق ingest على العنوان A نفسه). وحجوب على مسار العميل كما يفعل
الرقيب: DNS (إسقاط الاستعلام عن الاسم)، وIP (إسقاط TCP إلى العنوان)، وSNI (إسقاط اتصال TLS الذي يحمل الاسم في
ClientHello). لكل حجب ونقطة: نجح الرفع أم لا، وفي أي مرحلة فشل، وبعد كم ثانية. النتيجة partial دائمًا: المحاكاة
تثبت آلية التمييز لا سلوك رقيب حقيقي.

  python3 tools/netlab/blocking.py --out docs/measurements/netlab/$(date +%F)-ingest-blocking.json
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
FILES = ["infra/compose/docker-compose.yml", "tools/netlab/compose.netlab.yml",
         "infra/ingest/compose.ingest.yml", "tools/netlab/compose.blocking.yml"]
A, B, DNS = "172.30.252.2", "172.30.253.2", "172.30.252.3"
ENDPOINTS = {"main": ("app.example", False), "ingest": ("ingest.example", True),
             "ingest_shared": ("ingest-shared.example", True)}
# iptables على OUTPUT في حاوية العميل؛ كل حجب يُطبَّق وحده بعد تفريغ السلسلة.
BLOCKS = {
    "none": [],
    "dns_main": ["-p", "udp", "--dport", "53", "-m", "string", "--algo", "bm",
                 "--hex-string", "|03|app|07|example|", "-j", "DROP"],
    "ip_main": ["-p", "tcp", "-d", A, "-j", "DROP"],
    "sni_main": ["-p", "tcp", "--dport", "8443", "-m", "string", "--algo", "bm",
                 "--string", "app.example", "-j", "DROP"],
    "sni_ingest": ["-p", "tcp", "--dport", "8443", "-m", "string", "--algo", "bm",
                   "--string", "ingest.example", "-j", "DROP"],
    "ip_ingest": ["-p", "tcp", "-d", B, "-j", "DROP"],
}


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def compose(*args, env):
    cmd = ["docker", "compose"] + sum((["-f", os.path.join(ROOT, f)] for f in FILES), []) + list(args)
    return subprocess.run(cmd, env=env, capture_output=True, text=True, check=True).stdout


def in_client(*cmd, env, check=True):
    return subprocess.run(["docker", "compose"] + sum((["-f", os.path.join(ROOT, f)] for f in FILES), [])
                          + ["exec", "-T", "blocking-client", *cmd], env=env, capture_output=True, text=True,
                          check=check).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep", action="store_true", help="لا تُنزل compose في النهاية")
    a = ap.parse_args()

    keys = tempfile.mkdtemp()
    tok = os.path.join(ROOT, "infra", "ingest", "test_token.py")
    subprocess.run([sys.executable, tok, "keygen", keys, "--names",
                    "app.example,ingest.example,ingest-shared.example"], check=True)
    env = dict(os.environ, INGEST_TLS_DIR=os.path.join(keys, "tls"),
               INGEST_TOKEN_PUBLIC_KEYS="k1:" + open(os.path.join(keys, "public.b64")).read(),
               # reachability only: random sessions with no server behind them, as in infra/ingest/test-gate.sh
               INGEST_SESSION_CHECK="off")
    compose("up", "-d", "--wait", env=env)

    started_at, metrics, table = utc(), {}, []
    try:
        for block, rule in BLOCKS.items():
            in_client("iptables", "-F", "OUTPUT", env=env)
            if rule:
                in_client("iptables", "-A", "OUTPUT", *rule, env=env)
            for ep, (name, needs_token) in ENDPOINTS.items():
                sid = str(uuid.uuid4())
                args = ["python3", "/netlab/client.py", name, "--dns", DNS, "--ca", "/run/ingest/tls.crt",
                        "--sid", sid]
                if needs_token:
                    token = subprocess.run([sys.executable, tok, "mint", keys, "--sid", sid],
                                           capture_output=True, text=True, check=True).stdout
                    args += ["--token", token]
                r = json.loads(in_client(*args, env=env).strip().splitlines()[-1])
                key = f"{block}__{ep}"
                metrics[f"{key}__ok"] = r["ok"]
                metrics[f"{key}__stage"] = r["stage"]
                metrics[f"{key}__time_s"] = r["time_s"]
                table.append((block, ep, r))
                print(f"{block:11} {ep:14} {'ok' if r['ok'] else 'FAIL'} stage={r['stage']} "
                      f"t={r['time_s']}s {r['detail']}", flush=True)
        in_client("iptables", "-F", "OUTPUT", env=env)
    finally:
        if not a.keep:
            compose("down", "-v", env=env)

    ok = {(b, e): r["ok"] for b, e, r in table}
    main_blocks = ("dns_main", "ip_main", "sni_main")
    metrics.update({
        "baseline_all_ok": all(ok[("none", e)] for e in ENDPOINTS),
        "main_blocked_by_each_main_block": not any(ok[(b, "main")] for b in main_blocks),
        "ingest_survives_each_main_block": all(ok[(b, "ingest")] for b in main_blocks),
        "ingest_shared_survives_ip_main": ok[("ip_main", "ingest_shared")],
        "ingest_blocked_once_named_or_addressed": not ok[("sni_ingest", "ingest")] and not ok[("ip_ingest", "ingest")],
        "ech_tested": False,
    })
    doc = {
        "schema_version": 1,
        "tool": "netlab",
        "role": "infra",
        "decision_ref": 3,
        "started_at": started_at,
        "ended_at": utc(),
        "result": "partial",
        "device": {"platform": "server", "model": "docker compose (local), client in a netshoot container"},
        "network": {"profile": "blocking"},
        "upload_path": "tusd",
        "file": {"size_bytes": 262144},
        "metrics": metrics,
        "notes": ("SEC-07 / ADR 0011 blocking simulation. Endpoints: main = app.example on address A (stands in "
                  "for the Cloudflare-fronted domain), ingest = ingest.example on its own address B behind the "
                  "attestation-token gate, ingest_shared = an ingest name on address A. Blocks run on the "
                  "client's path (iptables in the client's netns): dns = drop queries for the name, ip = drop TCP "
                  "to the address, sni = drop TLS connections whose ClientHello carries the name. Partial: it "
                  "shows which property tells the endpoints apart under each block, not how a real censor behaves "
                  "(no ECH, no Cloudflare address sharing, no active probing, no real network). time_s on a failure is "
                  "the client's 5 s timeout, or ~0 where a drop on the client's own OUTPUT chain fails the send "
                  "at once (EPERM): it is not a censor's timing."),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps({k: v for k, v in metrics.items() if "__" not in k}, indent=2))


if __name__ == "__main__":
    main()
