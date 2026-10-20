"""عميل محاكاة الحجب (ADR 0011)، يعمل داخل حاوية العميل حيث قواعد الحجب. مكتبة بايثون القياسية فقط.

  client.py NAME --dns IP --ca FILE [--token JWT] [--size 262144]

يحاول رفع tus كاملًا إلى https://NAME:8443/files/ ويطبع سطر JSON: نجح أم لا، والمرحلة التي فشل فيها
(dns، tcp، tls، http)، والزمن حتى النجاح أو الفشل. الحلّ عبر محلّل DNS_IP مباشرة بطلب UDP (لا resolv.conf).
"""
import argparse
import base64
import http.client
import json
import os
import random
import socket
import ssl
import struct
import sys
import time
import uuid

TIMEOUT = 5.0


class Stage(Exception):
    def __init__(self, stage, detail):
        super().__init__(detail)
        self.stage, self.detail = stage, detail


def resolve(name, server):
    tid = random.randint(0, 65535)
    q = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00" + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(TIMEOUT / 2)
    try:
        for _ in range(2):
            try:
                s.sendto(q, (server, 53))
                data = s.recv(512)
            except socket.timeout:
                continue
            except OSError as e:  # a drop on the client's own OUTPUT chain fails the send at once (EPERM)
                raise Stage("dns", type(e).__name__)
            rcode, ancount = data[3] & 0x0F, struct.unpack(">H", data[6:8])[0]
            if rcode or not ancount:
                raise Stage("dns", f"rcode={rcode}")
            return socket.inet_ntoa(data[-4:])
        raise Stage("dns", "timeout")
    finally:
        s.close()


class Conn(http.client.HTTPSConnection):
    """يتصل بالعنوان المحلول ويرسل NAME في SNI وHost، ويفصل فشل TCP عن فشل TLS."""

    def __init__(self, name, ip, ctx):
        super().__init__(name, 8443, timeout=TIMEOUT, context=ctx)
        self.ip = ip

    def connect(self):
        try:
            sock = socket.create_connection((self.ip, 8443), TIMEOUT)
        except OSError as e:
            raise Stage("tcp", type(e).__name__)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except OSError as e:
            sock.close()
            raise Stage("tls", type(e).__name__)


def call(name, ip, ctx, method, path, headers, body=b""):
    c = Conn(name, ip, ctx)
    try:
        c.request(method, path, body=body or None, headers=headers)
        r = c.getresponse()
        r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}
    except Stage:
        raise
    except (OSError, http.client.HTTPException) as e:
        raise Stage("http", type(e).__name__)
    finally:
        c.close()


def upload(a):
    ip = resolve(a.name, a.dns)
    ctx = ssl.create_default_context(cafile=a.ca)
    sid = a.sid or str(uuid.uuid4())
    b64 = lambda v: base64.b64encode(v.encode()).decode()  # noqa: E731
    tus = {"Tus-Resumable": "1.0.0", "Authorization": "Bearer " + os.urandom(24).hex()}
    if a.token:
        tus["Ingest-Token"] = a.token
    st, h = call(a.name, ip, ctx, "POST", "/files/", {**tus, "Upload-Length": str(a.size),
                 "Upload-Metadata": f"upload_session_id {b64(sid)},filename {b64('blocking.bin')}"})
    if st != 201:
        raise Stage("http", f"create {st}")
    path = "/files/" + h["location"].rstrip("/").rsplit("/", 1)[1]
    st, h = call(a.name, ip, ctx, "PATCH", path, {**tus, "Upload-Offset": "0",
                 "Content-Type": "application/offset+octet-stream"}, os.urandom(a.size))
    if st != 204 or int(h.get("upload-offset", -1)) != a.size:
        raise Stage("http", f"patch {st}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--dns", required=True)
    ap.add_argument("--ca", required=True)
    ap.add_argument("--token")
    ap.add_argument("--sid")
    ap.add_argument("--size", type=int, default=262144)
    a = ap.parse_args()
    t0 = time.monotonic()
    out = {"ok": True, "stage": "done", "detail": ""}
    try:
        upload(a)
    except Stage as e:
        out = {"ok": False, "stage": e.stage, "detail": e.detail}
    out["time_s"] = round(time.monotonic() - t0, 2)
    print(json.dumps(out))
    sys.exit(0)


if __name__ == "__main__":
    main()
