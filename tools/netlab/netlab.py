#!/usr/bin/env python3
"""netlab — رفع tus عبر شبكة محاكاة (toxiproxy) وقياس الجلسة.

يسجّل لكل جلسة رفع: أطول نافذة اتصال متواصل، زمن كل جزء (طلب PATCH)، عدد الاستئنافات،
ونجاح التطابق (SHA-256 للأصل مقابل ما يعيده tusd). يكتب النتيجة بمخطط
contracts/schemas/measurement.json. مكتبة بايثون القياسية فقط.

مثال:
  python3 tools/netlab/netlab.py run --scenario office --size-mb 500 \
      --out docs/measurements/netlab/2026-10-19-tusd-office-500mb.json
"""
import argparse
import base64
import datetime as dt
import hashlib
import http.client
import json
import os
import platform
import statistics
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOXI_API = os.environ.get("NETLAB_TOXIPROXY_API", "http://127.0.0.1:8474")
UPSTREAM = os.environ.get("NETLAB_UPSTREAM", "tusd-proxy:8080")
DIRECT = os.environ.get("NETLAB_DIRECT", "127.0.0.1:8080")  # tusd-proxy بلا محاكاة، للتحقق فقط


def now():
    return time.monotonic()


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------- toxiproxy ----------

def toxi(method, path, body=None):
    req = urllib.request.Request(
        TOXI_API + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    # NETLAB الإداري محلي: لا وكيل HTTP.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=10) as r:
        data = r.read()
        return json.loads(data) if data else None


def kbps_to_toxi_rate(kbps):
    return max(1, int(kbps / 8))  # toxiproxy: KB/s


def apply_profile(name, p):
    for t in toxi("GET", f"/proxies/{name}/toxics") or []:
        toxi("DELETE", f"/proxies/{name}/toxics/{t['name']}")
    toxi("POST", f"/proxies/{name}/toxics", {"name": "up_bw", "type": "bandwidth", "stream": "upstream",
                                             "attributes": {"rate": kbps_to_toxi_rate(p["uplink_kbps"])}})
    toxi("POST", f"/proxies/{name}/toxics", {"name": "down_bw", "type": "bandwidth", "stream": "downstream",
                                             "attributes": {"rate": kbps_to_toxi_rate(p["downlink_kbps"])}})
    toxi("POST", f"/proxies/{name}/toxics", {"name": "lat", "type": "latency", "stream": "downstream",
                                             "attributes": {"latency": p["latency_ms"], "jitter": p["jitter_ms"]}})


def setup_proxy(sc, profile=None):
    """ينشئ الوسيط من جديد بملف السرعة. الحذف يقطع الاتصالات القائمة؛ إزالة سم bandwidth
    من وسيط فيه نقل جارٍ قد تعلق واجهة toxiproxy، لذلك لا تُعدَّل السموم على وسيط حي."""
    name = "netlab-" + sc["name"]
    try:
        toxi("DELETE", f"/proxies/{name}")
    except urllib.error.HTTPError:
        pass
    toxi("POST", "/proxies", {"name": name, "listen": f"0.0.0.0:{sc['listen_port']}",
                              "upstream": UPSTREAM, "enabled": True})
    apply_profile(name, profile or sc)
    return name


class Driver(threading.Thread):
    """ينفّذ أحداث السيناريو (انقطاع، تبديل شبكة) على خط زمني من بداية الرفع."""

    def __init__(self, name, sc, log):
        super().__init__(daemon=True)
        self.name_, self.sc, self.log = name, sc, log
        self.stop = threading.Event()
        self.scale = 1.0

    def run(self):
        t0 = now()
        try:
            for ev in self.sc["events"]:
                if ev["type"] == "blackout":
                    self._blackout(ev, t0)
                elif ev["type"] == "switch":
                    self._switch(ev, t0)
        except Exception as e:  # السيناريو لم يكتمل: يظهر في النتيجة ولا يُخفى
            self.log.append((round(now() - t0, 1), f"driver-error:{type(e).__name__}"))

    def _wait_until(self, t):
        return not self.stop.wait(max(0, t - now()))

    def _blackout(self, ev, t0):
        k = 1
        while self._wait_until(t0 + k * ev["every_s"] * self.scale):
            # timeout=0: لا يمر شيء والاتصال يبقى معلقًا حتى إزالة السم (ثقب أسود لا قطع).
            for stream in ("upstream", "downstream"):
                toxi("POST", f"/proxies/{self.name_}/toxics",
                     {"name": f"blackout_{stream}", "type": "timeout", "stream": stream,
                      "attributes": {"timeout": 0}})
            self.log.append((round(now() - t0, 1), "blackout-start"))
            if not self._wait_until(now() + ev["duration_s"] * self.scale):
                return
            for stream in ("upstream", "downstream"):
                toxi("DELETE", f"/proxies/{self.name_}/toxics/blackout_{stream}")
            self.log.append((round(now() - t0, 1), "blackout-end"))
            k += 1

    def _switch(self, ev, t0):
        k = 1
        while self._wait_until(t0 + k * ev["every_s"] * self.scale):
            prof = ev["profiles"][k % len(ev["profiles"])]
            # تغيّر الشبكة = عنوان جديد: الاتصالات القائمة تنقطع.
            setup_proxy(self.sc, prof)
            self.log.append((round(now() - t0, 1), "switch-" + prof["label"]))
            k += 1


# ---------- tus client ----------

class Session:
    def __init__(self):
        self.parts = []          # (seconds, bytes, ok)
        self.windows = []        # نوافذ الاتصال المتواصل المكتملة (ثوانٍ)
        self.connected_since = None
        self.resumes = 0
        self.failures = 0

    def ok(self, started):
        if self.connected_since is None:
            self.connected_since = started

    def fail(self):
        self.failures += 1
        if self.connected_since is not None:
            self.windows.append(now() - self.connected_since)
            self.connected_since = None

    def close(self):
        if self.connected_since is not None:
            self.windows.append(now() - self.connected_since)
            self.connected_since = None


def request(host, method, path, headers, body_file=None, offset=0, length=0, timeout=60, progress=None):
    conn = http.client.HTTPConnection(host, timeout=timeout)
    try:
        conn.putrequest(method, path, skip_accept_encoding=True)
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders()
        if body_file is not None:
            body_file.seek(offset)
            left = length
            while left:
                buf = body_file.read(min(65536, left))
                conn.send(buf)
                left -= len(buf)
                if progress:
                    progress(len(buf))
        r = conn.getresponse()
        r.read()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders())
    finally:
        conn.close()


def upload(path, size, host, chunk, deadline, s, timeout):
    tus = {"Tus-Resumable": "1.0.0"}
    meta = "filename " + base64.b64encode(os.path.basename(path).encode()).decode()
    url = None
    backoff = 1
    while url is None:
        t = now()
        if t > deadline:
            return None, 0
        try:
            st, h = request(host, "POST", "/files/", {**tus, "Upload-Length": str(size), "Upload-Metadata": meta},
                           timeout=timeout)
            if st != 201:
                raise IOError(f"create: HTTP {st}")
            url = urllib.parse.urlsplit(h["location"]).path
            s.ok(t)
        except (OSError, http.client.HTTPException):
            s.fail()
            time.sleep(backoff)
            backoff = min(backoff * 2, 10)

    offset, need_head = 0, False
    with open(path, "rb") as f:
        while offset < size and now() < deadline:
            t = now()
            try:
                if need_head:
                    st, h = request(host, "HEAD", url, tus, timeout=timeout)
                    if st != 200:
                        raise IOError(f"head: HTTP {st}")
                    offset = int(h["upload-offset"])
                    s.resumes += 1
                    need_head = False
                    s.ok(t)
                    continue
                n = min(chunk, size - offset)
                t = now()
                st, h = request(host, "PATCH", url,
                                {**tus, "Upload-Offset": str(offset),
                                 "Content-Type": "application/offset+octet-stream",
                                 "Content-Length": str(n)}, f, offset, n, timeout=timeout)
                if st != 204:
                    raise IOError(f"patch: HTTP {st}")
                offset = int(h["upload-offset"])
                s.parts.append((now() - t, n, True))
                s.ok(t)
                backoff = 1
            except (OSError, http.client.HTTPException):
                if not need_head:
                    s.parts.append((now() - t, 0, False))
                s.fail()
                need_head = True
                time.sleep(backoff)
                backoff = min(backoff * 2, 10)
    s.close()
    return url, offset


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def sha256_remote(url_path):
    conn = http.client.HTTPConnection(DIRECT, timeout=60)
    conn.request("GET", url_path)
    r = conn.getresponse()
    if r.status != 200:
        return None
    h = hashlib.sha256()
    for b in iter(lambda: r.read(1 << 20), b""):
        h.update(b)
    conn.close()
    return h.hexdigest()


def make_file(path, size_mb):
    if os.path.exists(path) and os.path.getsize(path) == size_mb << 20:
        return
    with open(path, "wb") as f:
        for _ in range(size_mb):
            f.write(os.urandom(1 << 20))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def run(a):
    with open(os.path.join(HERE, "scenarios", a.scenario + ".yaml")) as fh:
        sc = json.loads("".join(line for line in fh if not line.lstrip().startswith("#")))
    path = a.file or os.path.join(a.workdir, f"netlab-synthetic-{a.size_mb}mb.bin")
    make_file(path, a.size_mb)
    size = os.path.getsize(path)
    src_hash = sha256_file(path)

    name = setup_proxy(sc)
    events = []
    driver = Driver(name, sc, events)
    driver.scale = a.event_scale
    chunk = (a.chunk_mb or sc.get("client_chunk_mb", 4)) << 20
    started_at, t0 = utc(), now()
    driver.start()
    s = Session()
    url, offset = upload(path, size, f"127.0.0.1:{sc['listen_port']}", chunk, t0 + a.max_seconds, s, a.timeout_s)
    elapsed = now() - t0
    driver.stop.set()
    ended_at = utc()
    toxi("DELETE", f"/proxies/{name}")

    complete = url is not None and offset == size
    match = complete and sha256_remote(url) == src_hash
    ok_parts = [p[0] for p in s.parts if p[2]]
    m = {
        "upload_complete": complete,
        "checksum_match": bool(match),
        "bytes_uploaded": offset,
        "elapsed_s": round(elapsed, 1),
        "goodput_kbps": round(offset * 8 / 1000 / elapsed, 1) if elapsed else 0,
        "resumes": s.resumes,
        "connection_failures": s.failures,
        "longest_connected_window_s": round(max(s.windows), 1) if s.windows else 0,
        "client_chunk_bytes": chunk,
        "client_timeout_s": a.timeout_s,
        "parts_ok": len(ok_parts),
        "parts_failed": sum(1 for p in s.parts if not p[2]),
    }
    if ok_parts:
        m.update({
            "part_time_s_p50": round(statistics.median(ok_parts), 2),
            "part_time_s_p90": round(pct(ok_parts, 90), 2),
            "part_time_s_max": round(max(ok_parts), 2),
            "part_times_s": ",".join(f"{x:.1f}" for x in ok_parts),
        })
    m["events"] = ";".join(f"{t}s:{e}" for t, e in events) or "none"

    emulated = sc["name"] != "field-weak"
    network = {"profile": sc["name"], "uplink_kbps": sc["uplink_kbps"],
               "loss_pct": sc["loss_pct"] if emulated else 0}
    if sc["events"]:
        network["disconnect_every_s"] = sc["events"][0]["every_s"]
    network["longest_connected_window_s"] = m["longest_connected_window_s"]
    out = {
        "schema_version": 1,
        "tool": "netlab",
        "role": "infra",
        "test_name": "upload-resume",
        "decision_ref": 3,
        "started_at": started_at,
        "ended_at": ended_at,
        "result": "pass" if match else ("fail" if complete else "partial"),
        "device": {"platform": "server", "model": "netlab python client (stdlib)",
                   "os_version": f"{platform.system()} {platform.release()}"},
        "network": network,
        "upload_path": "tusd",
        "file": {"size_bytes": size, "codec": "synthetic-random"},
        "metrics": m,
        "notes": (f"toxiproxy 2.12.0 -> nginx tusd-proxy -> tusd v2.10.1 -> MinIO (local compose). "
                  f"Client: tools/netlab/netlab.py, time box {a.max_seconds}s, event scale {a.event_scale}. "
                  + ("" if emulated else f"loss_pct target {sc['loss_pct']} not emulated by toxiproxy (ADR 0005). ")
                  + "Connected window = client-observed time from first successful request to next failure."),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps({k: v for k, v in m.items() if k != "part_times_s"}, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--scenario", required=True, choices=["office", "field-weak", "field-switch"])
    r.add_argument("--size-mb", type=int, default=500)
    r.add_argument("--file", help="ملف اصطناعي موجود (لا ملفات مراسلين)")
    r.add_argument("--workdir", default=os.environ.get("TMPDIR", "/tmp"))
    r.add_argument("--chunk-mb", type=int, help="حجم PATCH؛ الافتراضي client_chunk_mb في السيناريو")
    r.add_argument("--timeout-s", type=int, default=60, help="مهلة خمول المقبس للعميل")
    r.add_argument("--event-scale", type=float, default=1.0, help="<1 لتجربة سريعة فقط؛ القياس بـ 1")
    r.add_argument("--max-seconds", type=int, default=7200)
    r.add_argument("--out", required=True)
    a = p.parse_args()
    run(a)


if __name__ == "__main__":
    main()
