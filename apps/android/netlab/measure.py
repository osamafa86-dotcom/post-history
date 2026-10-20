#!/usr/bin/env python3
"""قياس نواة الرفع في أندرويد (UploadEngine من apps/android/core على JVM) عبر حزمة tools/netlab.

يعيد استعمال أدوات tools/netlab/netlab.py كما هي (إعداد toxiproxy، الفقد بـ netem، مشغّل أحداث السيناريو،
بصمة الكائن في MinIO، وحساب حد Mathis) ويبدّل العميل فقط: بدل عميل بايثون يشغّل `netlab-runner`
(./gradlew :netlab-runner:installDist) الذي يدير UploadEngine الحقيقي ويطبع أحداثه سطرًا JSON لكل حدث.
النتيجة بمخطط contracts/schemas/measurement.json في docs/measurements/netlab/، وهي partial في أحسن
الأحوال: المرحلة (ب) على جهاز وشبكة فعليين وحدها تعطي pass.

  python3 apps/android/netlab/measure.py --scenario field-weak --size-mb 100 --max-seconds 2100 \
      --runner apps/android/netlab-runner/build/install/netlab-runner/bin/netlab-runner \
      --out docs/measurements/netlab/$(date -u +%F)-android-upload-core-field-weak-100mb.json

--tus-url http://host:port/files/ يتجاوز netlab كله (لتجربة محلية بلا docker؛ لا يُسجَّل كقياس).
"""
import argparse
import importlib.util
import json
import os
import platform
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def load_netlab():
    spec = importlib.util.spec_from_file_location("netlab", os.path.join(REPO, "tools", "netlab", "netlab.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_client(runner, path, tus_url, part_bytes, max_seconds, log):
    """يشغّل netlab-runner ويجمع أحداثه؛ يعيد (الأحداث، كود الخروج)."""
    cmd = [runner, "--file", path, "--tus", tus_url, "--part-bytes", str(part_bytes), "--max-seconds", str(max_seconds)]
    events = []
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as p:
        for line in p.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            ev = json.loads(line)
            events.append(ev)
            log(ev)
        err = p.stderr.read()
    if err.strip():
        # لا شيء كاشفًا في مخرجات العميل (ملف اصطناعي، عناوين محلية)؛ تُطبع للتشخيص فقط
        print(err.strip()[-2000:], file=sys.stderr)
    return events, p.returncode


def summarize(events, size):
    """المقاييس نفسها التي يحسبها netlab.py من أحداث العميل بدل حالته الداخلية.

    «المؤكَّد» هو ما يملكه الخادم: إقرار PATCH أو إزاحة `HEAD` (tusd يحتفظ بما وصله من طلب قُطع)، فالبايتات
    المرفوعة تُحسب من الاثنين، والمفقود هو تراجع `HEAD` دون آخر إزاحة أكّدها الخادم، والاستئناف كل `HEAD` بعد فشل.
    """
    parts, failures, resumes = [], 0, 0
    confirmed, bytes_lost = 0, 0
    windows, connected_since = [], None
    last_t = 0.0
    hash_s = None
    start_t = 0.0
    failed_since_head = False
    for ev in events:
        t = ev["t"]
        last_t = t
        kind = ev["ev"]
        if kind == "hashed":
            hash_s = t
            start_t = t  # النقل يبدأ بعد البصمة؛ زمن البصمة يُسجَّل على حدة
        elif kind in ("created", "head", "part"):
            if connected_since is None:
                connected_since = t
            if kind == "head":
                off = ev["offset"]
                if failed_since_head:
                    resumes += 1
                    failed_since_head = False
                bytes_lost += max(0, confirmed - off)
                confirmed = max(confirmed, off)
            elif kind == "part":
                parts.append((t, ev["from"], ev["to"]))
                confirmed = max(confirmed, ev["to"])
        elif kind == "fail":
            failures += 1
            failed_since_head = True
            if connected_since is not None:
                windows.append(t - connected_since)
                connected_since = None
    if connected_since is not None:
        windows.append(last_t - connected_since)
    # زمن الجزء = الفاصل بين إقرارين متتاليين (أو من بداية النقل/آخر HEAD إلى أول إقرار)
    part_times = []
    prev = None
    for ev in events:
        if ev["ev"] in ("hashed", "head", "fail"):
            prev = ev["t"]
        elif ev["ev"] == "part":
            if prev is not None:
                part_times.append(ev["t"] - prev)
            prev = ev["t"]
    end = next((e for e in events if e["ev"] == "end"), None)
    final_offset = max(confirmed, end["confirmed"]) if end else confirmed
    return {
        "parts_ok": len(parts), "parts_failed": failures, "resumes": resumes, "connection_failures": failures,
        "bytes_lost_on_resume": bytes_lost, "confirmed": final_offset, "windows": windows, "part_times": part_times,
        "hash_s": hash_s, "transfer_start_s": start_t, "end": end,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", choices=["office", "field-weak", "field-switch"], default="field-weak")
    ap.add_argument("--size-mb", type=int, default=100)
    ap.add_argument("--file", help="ملف اصطناعي موجود")
    ap.add_argument("--workdir", default=os.environ.get("RUNNER_TEMP") or os.environ.get("TMPDIR", "/tmp"))
    ap.add_argument("--part-mb", type=int, help="حجم طلب PATCH؛ الافتراضي client_chunk_mb في السيناريو")
    ap.add_argument("--max-seconds", type=int, default=3600)
    ap.add_argument("--event-scale", type=float, default=1.0)
    ap.add_argument("--runner", default=os.path.join(HERE, "..", "netlab-runner", "build", "install", "netlab-runner", "bin", "netlab-runner"))
    ap.add_argument("--tus-url", help="تجاوز netlab: نقطة tus مباشرة (تجربة محلية فقط)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    nl = load_netlab()
    with open(os.path.join(REPO, "tools", "netlab", "scenarios", a.scenario + ".yaml")) as fh:
        sc = json.loads("".join(line for line in fh if not line.lstrip().startswith("#")))
    path = a.file or os.path.join(a.workdir, f"netlab-synthetic-{a.size_mb}mb.bin")
    nl.make_file(path, a.size_mb)
    size = os.path.getsize(path)
    src_hash = nl.sha256_file(path)
    part_bytes = (a.part_mb or sc.get("client_chunk_mb", 4)) << 20

    direct = a.tus_url is not None
    events_log, driver, name, loss_mode = [], None, None, "none"
    if not direct:
        name = nl.setup_proxy(sc)
        loss_mode = nl.set_loss(sc["loss_pct"], sc["latency_ms"])
        if loss_mode == "netem":
            nl.toxi("DELETE", f"/proxies/{name}/toxics/lat")
        driver = nl.Driver(name, sc, events_log)
        driver.scale = a.event_scale
    tus_url = a.tus_url or f"http://127.0.0.1:{sc['listen_port']}/files/"

    started_at, t0 = nl.utc(), nl.now()
    if driver:
        driver.start()
    client_events, rc = run_client(a.runner, path, tus_url, part_bytes, a.max_seconds,
                                   log=lambda ev: print(json.dumps(ev), flush=True) if ev["ev"] != "part" or ev.get("to", 0) % (10 * part_bytes) == 0 else None)
    elapsed_total = nl.now() - t0
    if driver:
        driver.stop.set()
    ended_at = nl.utc()
    if not direct:
        nl.toxi("DELETE", f"/proxies/{name}")
        nl.set_loss(0)

    s = summarize(client_events, size)
    end = s["end"] or {}
    offset = s["confirmed"]
    complete = end.get("state") == "VERIFIED" and offset == size
    url = end.get("url")
    if direct:
        match = None
    else:
        match = bool(complete and url and nl.sha256_remote(nl.urllib.parse.urlsplit(url).path) == src_hash)
    device_hash_match = (end.get("sha256") == src_hash) if end.get("sha256") else None
    transfer_elapsed = max(1e-9, (end.get("t", elapsed_total) if end else elapsed_total) - (s["transfer_start_s"] or 0))

    m = {
        "upload_complete": bool(complete),
        "checksum_match": bool(match) if match is not None else False,
        "device_sha256_matches_source": bool(device_hash_match) if device_hash_match is not None else False,
        "bytes_uploaded": offset,
        "elapsed_s": round(transfer_elapsed, 1),
        "hash_s": round(s["hash_s"], 1) if s["hash_s"] is not None else -1,
        "goodput_kbps": round(offset * 8 / 1000 / transfer_elapsed, 1),
        "resumes": s["resumes"],
        "connection_failures": s["connection_failures"],
        "longest_connected_window_s": round(max(s["windows"]), 1) if s["windows"] else 0,
        "client_chunk_bytes": part_bytes,
        "client_timeout_s": 90,
        "request_target_s": 20,
        "parts_ok": s["parts_ok"],
        "parts_failed": s["parts_failed"],
        "loss_mode": loss_mode,
        "engine_outcome": end.get("outcome", "none"),
        "engine_state": end.get("state", "none"),
        "runner_exit_code": rc,
    }
    if s["part_times"]:
        pt = s["part_times"]
        m.update({"part_time_s_p50": round(statistics.median(pt), 2), "part_time_s_p90": round(nl.pct(pt, 90), 2),
                  "part_time_s_max": round(max(pt), 2), "part_times_s": ",".join(f"{x:.1f}" for x in pt)})
    if s["parts"]:
        sizes = [to - frm for _, frm, to in s["parts"]]
        m.update({"request_bytes_min": min(sizes), "request_bytes_median": int(statistics.median(sizes)), "request_bytes_max": max(sizes)})
    m["events"] = ";".join(f"{t}s:{e}" for t, e in events_log) or "none"

    down_s, start = 0.0, None
    for t, e in events_log:
        if e == "blackout-start":
            start = t
        elif e == "blackout-end" and start is not None:
            down_s, start = down_s + t - start, None
    if start is not None:
        down_s += max(0.0, elapsed_total - start)
    connected_s = max(1e-9, transfer_elapsed - down_s)
    m["bytes_lost_on_resume"] = s["bytes_lost_on_resume"]
    m["goodput_connected_kbps"] = round(offset * 8 / 1000 / connected_s, 1)
    stage_a = None
    if sc["loss_pct"] and sc["latency_ms"]:
        mathis = 1.22 * nl.MSS_BYTES * 8 / (sc["latency_ms"] / 1000 * (sc["loss_pct"] / 100) ** 0.5) / 1000
        capacity = min(mathis, sc["uplink_kbps"])
        m["mathis_limit_kbps"] = round(mathis, 1)
        m["efficiency_vs_mathis"] = round(m["goodput_connected_kbps"] / capacity, 3)
        if loss_mode == "netem":
            # As tools/netlab judges it: efficiency and zero loss. 100 MB at the field-weak Mathis limit needs
            # hours, so the time box ends the transfer; the server checksum is checked whenever it did complete.
            stage_a = m["efficiency_vs_mathis"] >= nl.STAGE_A_MIN_EFFICIENCY and s["bytes_lost_on_resume"] == 0
            m["stage_a_ok"] = stage_a
    if direct:
        result = "info"
    elif (complete and not match) or s["bytes_lost_on_resume"] or stage_a is False or (device_hash_match is False):
        result = "fail"
    else:
        result = "partial"

    network = {"profile": sc["name"], "uplink_kbps": sc["uplink_kbps"], "loss_pct": sc["loss_pct"]}
    if sc["events"]:
        network["disconnect_every_s"] = sc["events"][0]["every_s"]
    network["longest_connected_window_s"] = m["longest_connected_window_s"]
    out = {
        "schema_version": 1,
        "tool": "android-app",
        "role": "android",
        "test_name": "field-network-upload",
        "decision_ref": 3,
        "started_at": started_at,
        "ended_at": ended_at,
        "result": result,
        "device": {"platform": "server", "model": "UploadEngine + TusTransport (apps/android/core on JVM, tus-java-client 0.5.1)",
                   "os_version": f"{platform.system()} {platform.release()}"},
        "network": network,
        "upload_path": "tusd",
        "file": {"size_bytes": size, "codec": "synthetic-random"},
        "metrics": m,
        "notes": ("Client: the Android app's UploadEngine (hash on device -> session -> tus create -> resume from HEAD, "
                  "PATCH sized to the observed rate for ~20 s per request between 128 KiB and the session part size, "
                  "read timeout 90 s, backoff 2/5/15/30/60 s restarting whenever the server took bytes) run on the JVM by apps/android/netlab-runner; "
                  "POST/GET /uploads answered by an in-process stub (netlab has no API). "
                  f"Stack: {'direct tus endpoint (no netlab; not a measurement)' if direct else 'toxiproxy -> nginx tusd-proxy -> tusd -> MinIO (netlab overlay)'}. "
                  f"Time box {a.max_seconds}s, event scale {a.event_scale}. "
                  + {"netem": f"loss {sc['loss_pct']}% + delay {sc['latency_ms']}ms via tc netem. ",
                     "iptables-statistic": f"loss {sc['loss_pct']}% via iptables statistic, no delay (TCP impact understated). ",
                     "none": ""}[loss_mode]
                  + "elapsed_s counts the transfer only; hash_s is the on-device SHA-256 before the first byte. "
                  + "bytes_uploaded is what the server holds (acknowledged requests and HEAD offsets, tusd keeps the bytes of a cut request); "
                  + "resumes counts each HEAD after a failure. "
                  + "Never pass: field-network-upload stage (b) is 1 GB on a real device and network "
                  f"(stage (a): efficiency >= {nl.STAGE_A_MIN_EFFICIENCY:.0%} of Mathis, zero bytes lost on resume, netem, checksum match)."),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps({k: v for k, v in m.items() if k not in ("part_times_s", "events")}, indent=2))
    return 0 if result != "fail" else 1


if __name__ == "__main__":
    sys.exit(main())
