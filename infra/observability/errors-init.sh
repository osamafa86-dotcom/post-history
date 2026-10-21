#!/usr/bin/env bash
# تهيئة GlitchTip مرة بعد up (ADR 0029)، ومتكررة بأمان:
#   GLITCHTIP_ADMIN_PASSWORD=... infra/observability/errors-init.sh <بريد المشرف> [--env-file FILE]
# ينشئ المشرف فورًا (التسجيل في GlitchTip مفتوح ما دام لا مستخدم، فلا يُترك فارغًا)، والمؤسسة post-history ومشروعي
# api وweb، ويطبع DSN كل مشروع للتطبيقين على المضيف (المفتاح العام وحده، بصيغة Sentry). كلمة المرور من البيئة لا تُطبع.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMAIL="${1:?admin email}"; shift
C=(docker compose -f "$HERE/compose.errors.yml" "$@")
: "${GLITCHTIP_ADMIN_PASSWORD:?}"
[ "${#GLITCHTIP_ADMIN_PASSWORD}" -ge 16 ] || { echo "GLITCHTIP_ADMIN_PASSWORD: 16 characters at least" >&2; exit 2; }
printf '%s\n%s\n' "$EMAIL" "$GLITCHTIP_ADMIN_PASSWORD" | "${C[@]}" exec -T glitchtip ./manage.py shell -c '
import sys
from apps.users.models import User
from apps.organizations_ext.models import Organization, OrganizationUserRole
from apps.projects.models import Project, ProjectKey
email, password = sys.stdin.read().split("\n")[:2]
u = User.objects.filter(email=email).first()
if u is None:
    u = User.objects.create_superuser(email=email, password=password)
org = Organization.objects.filter(slug="post-history").first()
if org is None:
    org = Organization.objects.create(name="post-history", slug="post-history")
    org.add_user(u, role=OrganizationUserRole.OWNER)
for slug in ("api", "web"):
    p, _ = Project.objects.get_or_create(organization=org, slug=slug, defaults={"name": slug})
    k = ProjectKey.objects.filter(project=p).first() or ProjectKey.objects.create(project=p)
    print(f"{slug} DSN http://{k.public_key.hex}@127.0.0.1:3301/{p.id}")
' 2>/dev/null | grep ' DSN '
