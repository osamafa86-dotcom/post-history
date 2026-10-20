#!/usr/bin/env python3
"""نقطة /health المجمّعة الداخلية (ADR 0013): تقدّم آخر نتيجة لـ healthcheck.sh على 127.0.0.1 وحدها.
200 إن سلمت كل الفحوص وكانت النتيجة أحدث من HEALTH_MAX_AGE_S (180)، وإلا 503. أسماء الفحوص وحالتها فقط.
تعمل بمستخدم الخدمة غير الجذر (وحدة post-history-health-endpoint)، وتقرأ ملفًا واحدًا ولا تكتب شيئًا.
  python3 infra/observability/health-endpoint.py [--file /run/post-history/health/health.json] [--port 9180]
"""
import argparse
import datetime as dt
import http.server
import json
import os


def payload(path, max_age):
    try:
        with open(path) as fh:
            doc = json.load(fh)
        checked = dt.datetime.strptime(doc["checked_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        age = (dt.datetime.now(dt.timezone.utc) - checked).total_seconds()
    except (OSError, ValueError, KeyError) as err:
        return 503, {"ok": False, "error": f"no health result ({type(err).__name__})"}
    if age > max_age:
        return 503, dict(doc, ok=False, error=f"stale: {int(age)}s old")
    return (200 if doc.get("ok") else 503), doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="/run/post-history/health/health.json")
    ap.add_argument("--port", type=int, default=9180)
    ap.add_argument("--max-age", type=int, default=int(os.environ.get("HEALTH_MAX_AGE_S", "180")))
    a = ap.parse_args()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/health":
                self.send_error(404)
                return
            status, body = payload(a.file, a.max_age)
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # بلا سجل طلبات
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
