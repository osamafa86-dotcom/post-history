# صورة خادم المعاينة (ADR 0023): تُبنى في CI وحده (preview-images.yml)، والخادم المشترك يحمّلها ولا يبني. سياق البناء جذر
# المستودع: docker build -f infra/preview/api.Dockerfile -t post-history-preview-api:latest .
# إنتاج بلا أسرار ولا اعتماديات تطوير، ومستخدم node غير الجذر. الترحيل عند البدء بـ node-pg-migrate من node_modules
# (اعتمادية مقفلة في package-lock.json، لا npx ولا تثبيت منفصل: لا جلب من الشبكة على الخادم).
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /src
COPY apps/api/package.json apps/api/package-lock.json apps/api/
RUN cd apps/api && npm ci --no-audit --no-fund
COPY contracts contracts
COPY apps/api apps/api
RUN cd apps/api && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV NODE_ENV=production
# الخادم يقرأ العقد عند التشغيل من ../../contracts نسبةً إلى apps/api (common/contract.ts)، فالتخطيط نفسه هنا.
WORKDIR /app/apps/api
COPY --from=build /src/contracts /app/contracts
COPY --from=build /src/apps/api/package.json ./
COPY --from=build /src/apps/api/node_modules node_modules
COPY --from=build /src/apps/api/dist dist
COPY --from=build /src/apps/api/src/db/migrations migrations
COPY infra/preview/seed-preview.mjs preview/seed-preview.mjs
USER node
EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/node-pg-migrate up -m migrations -t schema_migrations --check-order --verbose=false && exec node dist/main.js"]
