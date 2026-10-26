#!/usr/bin/env bash
# كل صورة في مسار التشغيل مثبّتة بالبصمة (ADR 0004): compose الأساسي، وبوابة ingest، وبيئة التجربة، وصورة النسخ
# وتمرين الاستعادة، والمعاينة الخفيفة (صورتاها المبنيتان في CI محلية الاسم، وما سواهما بالبصمة)، وخادم التجربة (post-history-api:<commit> عبر API_IMAGE: مبنية من الالتزام نفسه وتُتحقق ببصمة أصول الإصدار، ADR 0050)، وPostgres التجربة مبنية من infra/postgres (WAL-G، ADR 0051) وأساسها بالبصمة. الوسم وحده يتحرك (7-alpine اليوم ليس 7-alpine غدًا)، والبصمة لا. يفشل بقائمة ما لم يُثبَّت.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
files=(infra/compose/docker-compose.yml infra/ingest/compose.ingest.yml infra/field-trial/docker-compose.trial.yml
       infra/preview/docker-compose.preview.yml infra/observability/compose.monitoring.yml infra/observability/compose.errors.yml)
bad="$( { grep -HnE '^\s*image:' "${files[@]}" | grep -vE '@sha256:[0-9a-f]{64}\s*$' | grep -vE 'image: post-history-preview-(api|web):latest$' \
          | grep -vE 'image: \$\{API_IMAGE:\?post-history-api:<commit>, set by trial.sh\}$' \
          | grep -vE 'docker-compose\.trial\.yml:[0-9]+:    image: !reset null$' || true
          grep -HnE '^FROM ' infra/backup/Dockerfile infra/deploy/test/Dockerfile infra/postgres/Dockerfile infra/preview/*.Dockerfile | grep -vE '@sha256:[0-9a-f]{64}( AS [a-z-]+)?\s*$' || true
          grep -HnE '^PG_IMAGE=' infra/backup/restore-drill.sh | grep -vE '@sha256:[0-9a-f]{64}"$' || true; } )"
if [ -n "$bad" ]; then echo "not pinned by digest:"; echo "$bad"; exit 1; fi
echo "images pinned by digest: ok"
