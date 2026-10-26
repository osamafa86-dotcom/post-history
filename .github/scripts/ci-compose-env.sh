#!/usr/bin/env bash
# Compose environment for the CI stacks: the example file with random secrets and the external upload verifier.
# Used by every job that starts the compose stack from source (media e2e, ai e2e), so the two cannot drift apart.
set -euo pipefail
cp infra/compose/.env.example infra/compose/.env
sed -i -e "s/^TUSD_HOOK_SECRET=.*/TUSD_HOOK_SECRET=$(openssl rand -hex 32)/" \
       -e "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" \
       -e "s|^FIELD_ENCRYPTION_KEY=.*|FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
       -e "s/^MEDIA_WORKER_TOKEN=.*/MEDIA_WORKER_TOKEN=$(openssl rand -hex 32)/" \
       -e "s/^UPLOAD_VERIFIER=.*/UPLOAD_VERIFIER=external/" \
       -e "s|^S3_PUBLIC_ENDPOINT=.*|S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000|" \
       -e "s/^AI_WORKER_TOKEN=.*/AI_WORKER_TOKEN=$(openssl rand -hex 32)/" \
       -e "s/^S3_AI_ACCESS_KEY=.*/S3_AI_ACCESS_KEY=ai-worker-ci/" \
       -e "s/^S3_AI_SECRET_KEY=.*/S3_AI_SECRET_KEY=$(openssl rand -hex 16)/" \
       -e "s/^S3_MEDIA_ACCESS_KEY=.*/S3_MEDIA_ACCESS_KEY=media-worker-ci/" \
       -e "s/^S3_MEDIA_SECRET_KEY=.*/S3_MEDIA_SECRET_KEY=$(openssl rand -hex 16)/" \
       -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" \
       -e "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$(openssl rand -hex 16)/" \
       -e "s/^S3_SECRET_KEY=.*/S3_SECRET_KEY=$(openssl rand -hex 16)/" infra/compose/.env
