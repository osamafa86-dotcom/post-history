"""بديل محلي لنقطة خطّافات tusd (SEC-06) لتشغيل netlab قبل وجود الخادم.

يقبل pre-create وpost-finish على /internal/tusd-hooks/<token> بعد مقارنة ثابتة الزمن،
ويرفض غيره بـ 401. لا يسجّل الجسم ولا الترويسات (فيها Authorization). لا يُستخدم خارج netlab.
كالخادم: إن حمل الرفع upload_session_id ثبّت pre-create معرّف tus عليه (بوابة ingest تربط الرمز به، ADR 0011).
"""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "/internal/tusd-hooks/"
TOKEN = os.environ["TUSD_HOOK_SECRET"].encode()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        token = self.path[len(PREFIX):].encode() if self.path.startswith(PREFIX) else b""
        ok = hmac.compare_digest(token, TOKEN)
        body = b""
        if ok:
            reply = {}
            try:
                hook = json.loads(raw or b"{}")
                sid = (hook.get("Event", {}).get("Upload", {}).get("MetaData") or {}).get("upload_session_id")
                if hook.get("Type") == "pre-create" and sid:
                    reply = {"ChangeFileInfo": {"ID": sid}}
            except ValueError:
                pass
            body = json.dumps(reply).encode()
        self.send_response(200 if ok else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # المسار يحمل الرمز: يُسجَّل الحكم فقط.
        print(f"hook {self.command} status={args[1] if len(args) > 1 else '?'}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
