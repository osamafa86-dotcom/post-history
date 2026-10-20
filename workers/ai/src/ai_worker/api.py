"""عميل نقطة الخادم الداخلية `POST /internal/media/files/{file_id}/derivatives` (ADR 0006، 0020).

العامل يسجّل مشتقًا فقط ولا يقرر شيئًا على المادة. الرمز `AI_WORKER_TOKEN` في ترويسة `Authorization` ولا يُسجَّل،
ورسائل الأخطاء تحمل المسار (معرّفات UUID فقط) ورمز الحالة، لا جسم الرد. التصنيف كعميل عامل الوسائط.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

# اتصال مباشر: متغيرات HTTP(S)_PROXY في البيئة لا تمرّر الرمز عبر وسيط
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ApiError(RuntimeError):
    """عطل مؤقت (شبكة، 5xx، 429): يُعاد المحاولة لاحقًا."""


class ApiRejected(RuntimeError):
    """رفض نهائي (4xx غير 409/429)، ومنه 422 لنوع مشتق لم يقبله العقد بعد."""


class ApiAuthError(RuntimeError):
    """401/403/404: الخادم يرد 404 على رمز غير مطابق، فلا يُميَّز عن تهيئة خاطئة؛ يُعاد بتراجع ولا يُقَرّ الحدث."""


class ApiGone(RuntimeError):
    """410 `media_resource_gone`: الملف المصدر غير موجود. نهائي."""


class ApiConflict(RuntimeError):
    """409: مشتق مختلف من النوع نفسه مسجّل لهذا الملف، أو المصدر ليس أصلًا متحققًا منه."""


class InternalApi:
    def __init__(self, base_url: str, token: str, timeout_s: float = 30):
        if len(token) < 32:
            raise ValueError("AI_WORKER_TOKEN must be at least 32 characters")
        self.base = base_url.rstrip("/")
        self._token = token
        self.timeout_s = timeout_s

    def _call(self, method: str, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"{self.base}{path}", data=json.dumps(body).encode(), method=method,
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

    def add_derivative(self, file_id: str, body: dict) -> dict:
        return self._call("POST", f"/internal/media/files/{file_id}/derivatives", body)
