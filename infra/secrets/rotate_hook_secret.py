#!/usr/bin/env python3
"""تمرين تدوير سر واحد (SEC-05): رمز خطّاف tusd، على compose المحلي بملف الخادم (profile api).

يولّد رمزًا جديدًا، يكتبه في infra/compose/.env، ويعيد إنشاء الخادم ثم tusd، بينما مسبار يرسل طلب إنشاء رفع
برمز رفع عشوائي كل ربع ثانية. الحكم على المسار من رد tusd:
  403 = الخطّاف وصل الخادم برمز صحيح ورُفض الرفع (المسار سليم)
  غير ذلك (500 أو مهلة أو انقطاع) = مسار الخطّاف معطّل
ويقيس نافذة التعطّل والزمن الكلي، ويتحقق أن الرمزين القديم والجديد لا يظهران في سجل tusd، ويكتب النتيجة بمخطط
contracts/schemas/measurement.json. مكتبة بايثون القياسية فقط.

  python3 infra/secrets/rotate_hook_secret.py --out docs/measurements/ops/$(date +%F)-rotate-tusd-hook-secret.json
"""
import argparse
import base64
import datetime as dt
import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COMPOSE_DIR = os.path.normpath(os.path.join(HERE, "..", "compose"))
ENV_FILE = os.path.join(COMPOSE_DIR, ".env")


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def compose(*args, extra=None):
    cmd = ["docker", "compose", "-f", os.path.join(COMPOSE_DIR, "docker-compose.yml")]
    if extra:
        cmd += ["-f", extra]
    return subprocess.run(cmd + ["--profile", "api", *args], capture_output=True, text=True, check=True).stdout


def read_env():
    with open(ENV_FILE) as fh:
        return dict(line.rstrip("\n").split("=", 1) for line in fh if "=" in line and not line.startswith("#"))


def set_env(key, value):
    with open(ENV_FILE) as fh:
        text = fh.read()
    text, n = re.subn(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
    if n != 1:
        raise SystemExit(f"{key} must appear exactly once in {ENV_FILE}")
    with open(ENV_FILE, "w") as fh:
        fh.write(text)


def probe(url):
    meta = "upload_session_id " + base64.b64encode(b"00000000-0000-4000-8000-000000000000").decode()
    req = urllib.request.Request(url, method="POST", headers={
        "Tus-Resumable": "1.0.0", "Upload-Length": "10", "Upload-Metadata": meta,
        "Authorization": "Bearer " + secrets.token_hex(24),  # random: never a valid upload token
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except OSError:
        return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--extra-compose", help="ملف compose إضافي (مثل تخطي npm ci على مضيف بلا شبكة داخل الحاويات)")
    ap.add_argument("--settle-s", type=float, default=20.0, help="مدة المسبار بعد التدوير")
    a = ap.parse_args()

    env = read_env()
    url = f"http://127.0.0.1:{env['TUSD_PORT']}/files/"
    old = env["TUSD_HOOK_SECRET"]
    if probe(url) != 403:
        raise SystemExit("hook path is not healthy before rotation (expected 403 from the API via the hook)")

    results, stop = [], threading.Event()
    t0 = time.monotonic()

    def prober():
        threads = []
        while not stop.is_set():
            def one(start=time.monotonic()):
                results.append((start - t0, probe(url)))
            th = threading.Thread(target=one, daemon=True)
            th.start()
            threads.append(th)
            stop.wait(0.25)
        for th in threads:
            th.join()

    p = threading.Thread(target=prober)
    p.start()
    time.sleep(3)

    started_at, r0 = utc(), time.monotonic()
    new = secrets.token_hex(32)
    set_env("TUSD_HOOK_SECRET", new)
    # الخادم أولًا (يقبل الرمز الجديد وحده)، ثم tusd: النافذة = من توقف الخادم القديم إلى بدء tusd الجديد.
    compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "api", extra=a.extra_compose)
    t_api = time.monotonic() - r0
    compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "tusd", extra=a.extra_compose)
    rotation_s = time.monotonic() - r0
    time.sleep(a.settle_s)
    stop.set()
    p.join()
    ended_at = utc()

    results.sort()
    bad = [t for t, code in results if code != 403]
    after = [code for t, code in results if t > (r0 - t0) + rotation_s + 5]
    logs = compose("logs", "tusd", extra=a.extra_compose)
    leaked = (old in logs) or (new in logs)
    healthy_after = bool(after) and all(c == 403 for c in after)
    metrics = {
        "rotation_total_s": round(rotation_s, 1),
        "api_recreate_s": round(t_api, 1),
        "hook_outage_window_s": round(bad[-1] - bad[0], 1) if bad else 0.0,
        "probes_total": len(results),
        "probes_failed": len(bad),
        "healthy_after_rotation": healthy_after,
        "secret_in_tusd_log": leaked,
        "within_one_hour": rotation_s < 3600,
    }
    doc = {
        "schema_version": 1,
        "tool": "other",
        "role": "infra",
        "started_at": started_at,
        "ended_at": ended_at,
        "result": "pass" if healthy_after and not leaked and rotation_s < 3600 else "fail",
        "device": {"platform": "server", "model": "docker compose (local)"},
        "metrics": metrics,
        "notes": ("SEC-05 rotation drill: TUSD_HOOK_SECRET rotated in infra/compose/.env, api then tusd recreated "
                  "while a prober created uploads with a random token every 0.25 s (403 = hook path healthy). "
                  "The outage window is the API restart: the API accepts one hook token, so tusd's hooks fail "
                  "until both sides carry the new one (ADR SEC-05)."),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps(metrics, indent=2))
    raise SystemExit(0 if doc["result"] == "pass" else 1)


if __name__ == "__main__":
    main()
