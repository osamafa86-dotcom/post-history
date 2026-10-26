#!/usr/bin/env bash
# لا مفتاح خاص في المستودع (ADR 0051، الشرط 2): مفتاح استعادة WAL-G ومفتاح مستلم النسخ ومفاتيح التوقيع خارج المستودع
# وخارج ملفات compose والبيئة. يفحص كل ملف متتبَّع عن ترويسة مفتاح خاص مدرّعة (PEM أو PGP)، ويفشل بقائمتها. أخوه على
# المضيف: preflight.sh (ملف الأسرار ومجلد المفتاح العام)، وفي الدخان: بيئة كل حاوية والملفات المركّبة فيها.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
hits="$(git grep -nIE -e '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----' -- . || true)"
if [ -n "$hits" ]; then echo "a private key in the repository:"; echo "$hits"; exit 1; fi
echo "no private key in $(git ls-files | wc -l) tracked files: ok"
