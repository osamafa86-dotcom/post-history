# النسخ الاحتياطي واستعادته (ADR 0013): pg_dump من صورة Postgres نفسها، وmc الثابت من صورة mc المثبّتة
# (ADR 0004)، وopenssl للتشفير بالمفتاح العام (CMS): الخادم يشفّر ولا يستطيع فك نسخه.
FROM pgsty/mc:RELEASE.2026-10-18T00-00-00Z@sha256:6ecdaec70bc5e8cf9d0e9a70c190f3beb1c83f11617ff4333f1fcd71ab1daf18 AS mc

FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
RUN apk add --no-cache openssl
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
COPY backup.sh /usr/local/bin/backup.sh
# postgres (uid 70) في الصورة؛ مجلد النسخ على المضيف يُملَّك له (docs/ops/field-trial-hosting.md).
USER postgres
ENV MC_CONFIG_DIR=/tmp/.mc
ENTRYPOINT ["sh", "/usr/local/bin/backup.sh"]
CMD ["loop"]
