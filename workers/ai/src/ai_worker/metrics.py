"""مقاييس العامل إلى المجمّع المستضاف ذاتيًا (ADR 0027، تعديل 2026-11-11).

OTLP/HTTP بصيغة JSON إلى `<endpoint>/v1/metrics`، بالمكتبة القياسية وحدها. بلا عنوان مضبوط لا يخرج شيء من العامل.
التسميات قائمة مغلقة: الطابور، ونوع الحدث، والنتيجة. لا معرّف مادة أو جلسة، ولا اسم ملف، ولا نص خطأ في تسمية أو قيمة.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.request
from collections import defaultdict

log = logging.getLogger("ai_worker.metrics")

# اتصال مباشر إلى المجمّع الداخلي: متغيرات HTTP(S)_PROXY في البيئة لا تمرّر المقاييس عبر وسيط
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# نوع الحدث كما ينشره الخادم (`upload.original_received`)؛ ما ليس بهذا الشكل يُعدّ `other`
EVENT_TYPE = re.compile(r"[a-z][a-z_.]{0,63}")
OUTCOMES = ("done", "deferred", "dead")
# حدود مدة الحدث بالثواني: من مادة قصيرة إلى تفريغ ساعة
DURATION_BOUNDS_S = (1.0, 5.0, 15.0, 60.0, 300.0, 900.0, 3600.0)


class Metrics:
    def __init__(self, endpoint: str | None, service: str, interval_s: float = 30.0, clock=time.monotonic, now=time.time,
                 timeout_s: float = 2.0, prefix: str = "ai.worker"):
        self.endpoint = endpoint.rstrip("/") if endpoint else None
        self.service = service
        self.interval_s = interval_s
        self.clock = clock
        self.now = now
        self.timeout_s = timeout_s
        self.prefix = prefix
        self.started_ns = int(now() * 1e9)
        self.last_push = clock()
        self.counts: dict[tuple[str, str, str], int] = defaultdict(int)
        self.buckets: dict[tuple[str, str, str], list[int]] = {}
        self.seconds: dict[tuple[str, str, str], float] = defaultdict(float)

    def event(self, queue: str, event_type: object, outcome: str, seconds: float) -> None:
        """حدث انتهت معالجته في هذا التسليم: `done` أو `deferred` أو `dead`، ومدته."""
        kind = event_type if isinstance(event_type, str) and EVENT_TYPE.fullmatch(event_type) else "other"
        key = (queue, kind, outcome if outcome in OUTCOMES else "other")
        self.counts[key] += 1
        self.seconds[key] += seconds
        buckets = self.buckets.setdefault(key, [0] * (len(DURATION_BOUNDS_S) + 1))
        buckets[next((i for i, bound in enumerate(DURATION_BOUNDS_S) if seconds <= bound), len(DURATION_BOUNDS_S))] += 1

    def payload(self) -> dict:
        at = str(int(self.now() * 1e9))
        start = str(self.started_ns)

        def attributes(key: tuple[str, str, str]) -> list[dict]:
            return [{"key": name, "value": {"stringValue": value}} for name, value in zip(("queue", "event.type", "outcome"), key)]

        events = [{"attributes": attributes(k), "startTimeUnixNano": start, "timeUnixNano": at, "asInt": str(n)}
                  for k, n in sorted(self.counts.items())]
        durations = [{"attributes": attributes(k), "startTimeUnixNano": start, "timeUnixNano": at, "count": str(self.counts[k]),
                      "sum": self.seconds[k], "bucketCounts": [str(c) for c in b], "explicitBounds": list(DURATION_BOUNDS_S)}
                     for k, b in sorted(self.buckets.items())]
        # اسم الخدمة في اسم النطاق (scope)، فيصل Prometheus تسميةً مع كل مقياس؛ لا خصائص مورد
        return {"resourceMetrics": [{
            "resource": {"attributes": []},
            "scopeMetrics": [{"scope": {"name": self.service}, "metrics": [
                {"name": f"{self.prefix}.events", "sum": {"aggregationTemporality": 2, "isMonotonic": True, "dataPoints": events}},
                {"name": f"{self.prefix}.event.duration", "unit": "s", "histogram": {"aggregationTemporality": 2, "dataPoints": durations}},
            ]}],
        }]}

    def flush_if_due(self) -> bool:
        """يرسل المقاييس إن مضت المهلة منذ آخر إرسال. عطل المجمّع لا يُسقط العامل ولا يؤخره أكثر من مهلة الطلب."""
        if not self.endpoint or self.clock() - self.last_push < self.interval_s:
            return False
        self.last_push = self.clock()
        request = urllib.request.Request(f"{self.endpoint}/v1/metrics", data=json.dumps(self.payload()).encode(), method="POST",
                                         headers={"Content-Type": "application/json"})
        try:
            with DIRECT.open(request, timeout=self.timeout_s):  # noqa: S310 (عنوان داخلي من الإعداد)
                return True
        except Exception as err:  # noqa: BLE001 (المراقبة لا تُسقط العمل)
            log.warning("metrics push failed error=%s", type(err).__name__)
            return False
