"""عميل S3 صغير (MinIO محليًا، R2 في الإنتاج) بتوقيع AWS SigV4 ومسار بنمط path-style.

ثلاث عمليات فقط: HEAD وGET تدفقي للأصل، وPUT لملف مشتق جديد. لا حذف ولا كتابة فوق مفتاح الأصل:
`put` يرفض أي حاوية غير حاوية المشتقات وأي مفتاح خارج `derived/`.
"""

from __future__ import annotations

import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

CHUNK = 8 * 1024 * 1024
# مستخدم التخزين يكتب هنا فقط (media/derived/*)؛ العميل يفرض القيد نفسه
DERIVED_PREFIX = "derived/"
# اتصال مباشر: متغيرات HTTP(S)_PROXY في البيئة لا تمرّر الأصل ولا التوقيع عبر وسيط
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class StorageError(RuntimeError):
    """عطل مؤقت أو تهيئة؛ يُعاد المحاولة لاحقًا."""


class ObjectMissing(StorageError):
    """الكائن غير موجود (404): خطأ تخزين نهائي للجلسة (`storage_error`)."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign_v4(method: str, url: str, headers: dict[str, str], payload_hash: str, access_key: str,
            secret_key: str, region: str, now: datetime, service: str = "s3") -> dict[str, str]:
    """يعيد الترويسات موقّعة. كل ترويسة مُمرَّرة تدخل التوقيع."""
    parts = urllib.parse.urlsplit(url)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    signed = {k.lower(): " ".join(v.strip().split()) for k, v in headers.items()}
    signed.update({"host": parts.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date})
    names = sorted(signed)
    query = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    )
    canonical = "\n".join([
        method, urllib.parse.quote(parts.path or "/", safe="/-_.~"), query,
        "".join(f"{n}:{signed[n]}\n" for n in names), ";".join(names), payload_hash,
    ])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, _sha256(canonical.encode())])
    key = _hmac(_hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), service), "aws4_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    out = {k: v for k, v in signed.items() if k != "host"}
    out["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
    )
    return out


class S3Storage:
    def __init__(self, endpoint: str, region: str, access_key: str, secret_key: str, writable_bucket: str,
                 timeout_s: float = 60):
        self.endpoint = endpoint.rstrip("/")
        self.region = region
        self.access_key = access_key
        self.secret_key = secret_key
        self.writable_bucket = writable_bucket
        self.timeout_s = timeout_s

    def _url(self, bucket: str, key: str) -> str:
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise ValueError("invalid object key")
        return f"{self.endpoint}/{urllib.parse.quote(bucket)}/{urllib.parse.quote(key, safe='/')}"

    def _open(self, method: str, bucket: str, key: str, body=None, payload_hash: str = _sha256(b""),
              headers: dict[str, str] | None = None):
        url = self._url(bucket, key)
        signed = sign_v4(method, url, headers or {}, payload_hash, self.access_key, self.secret_key,
                         self.region, datetime.now(timezone.utc))
        req = urllib.request.Request(url, data=body, method=method, headers=signed)
        try:
            return DIRECT.open(req, timeout=self.timeout_s)  # noqa: S310 (عنوان التخزين من الإعداد)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                raise ObjectMissing(f"{method} {bucket}: not found") from None
            # لا يُعاد جسم الخطأ: قد يحمل المفتاح، والمفاتيح قد تحمل معرّفات
            raise StorageError(f"{method} {bucket}: HTTP {err.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise StorageError(f"{method} {bucket}: {type(err).__name__}") from None

    def head(self, bucket: str, key: str) -> int:
        with self._open("HEAD", bucket, key) as resp:
            return int(resp.headers["Content-Length"])

    def read(self, bucket: str, key: str, chunk_size: int = CHUNK) -> Iterator[bytes]:
        with self._open("GET", bucket, key) as resp:
            while chunk := resp.read(chunk_size):
                yield chunk

    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None:
        if bucket != self.writable_bucket or not key.startswith(DERIVED_PREFIX):
            raise PermissionError("the worker writes derived files only")
        size = path.stat().st_size
        with open(path, "rb") as fh:
            # التخزين يتحقق من x-amz-content-sha256 فيرفض جسمًا تلف في الطريق
            with self._open("PUT", bucket, key, body=fh, payload_hash=sha256_hex,
                            headers={"content-type": content_type, "content-length": str(size)}):
                pass
