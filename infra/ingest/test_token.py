#!/usr/bin/env python3
"""مفاتيح ورموز اختبار لبوابة ingest (ADR 0011). مكتبة بايثون القياسية وopenssl فقط؛ لا مفتاح حقيقي هنا أبدًا:
في الإنتاج يصدر الخادم الرموز بعد التحقق من شهادة الجهاز، ومفتاحه الخاص في SOPS.

  test_token.py keygen DIR [--names ingest.localhost,localhost]   # DIR/signing.pem, DIR/public.b64, DIR/tls/tls.{crt,key}
  test_token.py mint DIR --sid UUID [--aud ingest] [--ttl 600] [--iat-offset 0] [--alg ES256]
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def der_to_raw(sig: bytes) -> bytes:
    """ECDSA-Sig-Value (DER) -> r||s بطول 32 لكلٍّ، كما في JWS ES256."""
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert sig[i] == 0x02
        n = sig[i + 1]
        out += sig[i + 2:i + 2 + n].lstrip(b"\x00").rjust(32, b"\x00")
        i += 2 + n
    return out


def keygen(a):
    os.makedirs(a.dir, exist_ok=True)
    key = os.path.join(a.dir, "signing.pem")
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key)
    spki = openssl("ec", "-in", key, "-pubout", "-outform", "DER")
    with open(os.path.join(a.dir, "public.b64"), "w") as fh:
        fh.write(base64.b64encode(spki).decode())
    # الشهادة وحدها في مجلد يُركَّب في البوابة؛ مفتاح التوقيع يبقى خارجه (البوابة لا ترى إلا المفتاح العام).
    tls = os.path.join(a.dir, "tls")
    os.makedirs(tls, exist_ok=True)
    os.chmod(tls, 0o755)
    names = a.names.split(",")
    san = ",".join(f"DNS:{n}" for n in names)
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
            "-subj", f"/CN={names[0]}", "-addext", f"subjectAltName={san}",
            "-keyout", os.path.join(tls, "tls.key"), "-out", os.path.join(tls, "tls.crt"))
    for f in ("tls.key", "tls.crt"):
        os.chmod(os.path.join(tls, f), 0o644)  # يقرؤها مستخدم nginx في الحاوية؛ شهادة اختبار فقط


def mint(a):
    now = int(time.time()) + a.iat_offset
    header = {"alg": a.alg, "typ": "JWT"}
    claims = {"aud": a.aud, "sid": a.sid, "iat": now, "exp": now + a.ttl, "jti": b64url(os.urandom(12))}
    signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(claims).encode())}"
    if a.alg == "none":
        sig = b""
    else:
        der = openssl("dgst", "-sha256", "-sign", os.path.join(a.dir, "signing.pem"), data=signing_input.encode())
        sig = der_to_raw(der)
    sys.stdout.write(f"{signing_input}.{b64url(sig)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen")
    k.add_argument("dir")
    k.add_argument("--names", default="ingest.localhost,localhost")
    m = sub.add_parser("mint")
    m.add_argument("dir")
    m.add_argument("--sid", required=True)
    m.add_argument("--aud", default="ingest")
    m.add_argument("--ttl", type=int, default=600)
    m.add_argument("--iat-offset", type=int, default=0)
    m.add_argument("--alg", default="ES256")
    a = ap.parse_args()
    keygen(a) if a.cmd == "keygen" else mint(a)


if __name__ == "__main__":
    main()
