"""عميل نقاط الخادم الداخلية `/internal/media/*` (ADR 0006).

الرمز في ترويسة `Authorization` ولا يُسجَّل؛ رسائل الأخطاء تحمل المسار (معرّفات UUID فقط) ورمز الحالة، لا جسم الرد.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

# اتصال مباشر: متغيرات HTTP(S)_PROXY في البيئة لا تمرّر الرمز ولا الأصل عبر وسيط
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ApiError(RuntimeError):
    """عطل مؤقت (شبكة، 5xx، 429): يُعاد المحاولة لاحقًا."""


class ApiRejected(RuntimeError):
    """رفض نهائي (4xx غير 409/429): إعادة المحاولة لا تغيّره."""


class ApiAuthError(RuntimeError):
    """401/403/404 من النقاط الداخلية: الخادم يرد 404 على رمز غير مطابق (كبقية `/internal/*`)، فلا يُميَّز عن
    تهيئة خاطئة أو رمز دُوِّر للتو. يُعاد المحاولة بتراجع ولا يُقَرّ الحدث، فلا تضيع أحداث أثناء تدوير الرمز."""


class ApiGone(RuntimeError):
    """410 `media_resource_gone`: الرمز صحيح والجلسة أو الملف غير موجود (عقد v0.1). نهائي، ولا إبلاغ بعده."""


class ApiConflict(RuntimeError):
    """409: الخادم سجّل نتيجة مختلفة لهذه الجلسة؛ الحدث منتهٍ."""


@dataclass(frozen=True)
class Session:
    id: str
    material_id: str
    kind: str
    state: str
    size_bytes: int
    storage_key: str | None
    material_has_proxy: bool


@dataclass(frozen=True)
class FileRef:
    """ملف مصدر يبني منه العامل مشتقًا عند الطلب (`MediaSourceFile`، v0.3): معاينة المتجر وحزمة التصدير."""
    file_id: str
    material_id: str
    storage_key: str
    size_bytes: int | None
    sha256: str | None
    kind: str = "original"
    state: str = "verified"


class InternalApi:
    def __init__(self, base_url: str, token: str, timeout_s: float = 30):
        if len(token) < 32:
            raise ValueError("MEDIA_WORKER_TOKEN must be at least 32 characters")
        self.base = base_url.rstrip("/")
        self._token = token
        self.timeout_s = timeout_s

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base}{path}", data=data, method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json",
                     "Accept": "application/json"},
        )
        try:
            with DIRECT.open(req, timeout=self.timeout_s) as resp:  # noqa: S310 (عنوان داخلي من الإعداد)
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            label = f"{method} {path}: HTTP {err.code}"
            if err.code == 409:
                raise ApiConflict(label) from None
            if err.code == 410:
                raise ApiGone(label) from None
            if err.code in (401, 403, 404):
                raise ApiAuthError(label) from None
            if err.code == 429 or err.code >= 500:
                raise ApiError(label) from None
            raise ApiRejected(label) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise ApiError(f"{method}: {type(err).__name__}") from None

    def get_session(self, session_id: str) -> Session:
        d = self._call("GET", f"/internal/media/sessions/{session_id}")
        return Session(
            id=session_id, material_id=d["material_id"], kind=d["kind"], state=d["state"],
            size_bytes=int(d["size_bytes"]), storage_key=d.get("storage_key"),
            material_has_proxy=bool(d.get("material_has_proxy")),
        )

    def report_verification(self, session_id: str, body: dict) -> dict:
        """يعيد `{state, file_id, receipt_number, failure_reason}`؛ تكرار بلاغ موافق يعيد النتيجة المسجلة نفسها."""
        return self._call("POST", f"/internal/media/sessions/{session_id}/verification", body)

    def add_derivative(self, file_id: str, body: dict) -> dict:
        return self._call("POST", f"/internal/media/files/{file_id}/derivatives", body)

    def get_file(self, file_id: str) -> FileRef:
        """`GET /internal/media/files/{id}`: مفتاح التخزين والبصمة فقط؛ الملف المحذوف `410` (`ApiGone`)."""
        d = self._call("GET", f"/internal/media/files/{file_id}")
        return FileRef(file_id=d["file_id"], material_id=d["material_id"], storage_key=d["storage_key"],
                       size_bytes=d.get("size_bytes"), sha256=d.get("sha256"), kind=d["kind"], state=d["state"])
