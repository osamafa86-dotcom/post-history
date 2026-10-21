# صورة الويب للمعاينة (ADR 0023): تُبنى في CI وحده. سياق البناء جذر المستودع:
#   docker build -f infra/preview/web.Dockerfile -t post-history-preview-web:latest .
# next build في مرحلة، ثم اعتماديات الإنتاج وحدها مع .next في الصورة النهائية، بمستخدم node غير الجذر وبلا أسرار.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /src/apps/web/package.json /src/apps/web/next.config.ts ./
COPY --from=build /src/apps/web/node_modules node_modules
COPY --from=build /src/apps/web/.next .next
COPY --from=build /src/apps/web/messages messages
USER node
EXPOSE 3100
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3100"]
