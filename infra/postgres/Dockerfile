# Postgres للتجربة مع WAL-G (ADR 0051): أرشفة WAL المستمرة ونسخ أساسية إلى المزوّد الثاني، مشفّرة بمفتاح PGP عام.
# WAL-G مبني من مصدر الوسم المثبّت بالتزامه (التحقق قبل البناء)، ثابت بلا cgo؛ والأساس صورة compose نفسها بالبصمة (ADR 0004).
FROM golang:1.25.11-alpine3.22@sha256:65b4400aee0927412e9ed791a11893273a49d55df24841f7599660fb80dae464 AS walg
ARG WALG_TAG=v3.0.9
ARG WALG_COMMIT=3e493188db28335fb93a45bd680c6ff8fc3028c1
RUN apk add --no-cache git
RUN git clone -q --depth 1 --branch "$WALG_TAG" https://github.com/wal-g/wal-g /src \
 && [ "$(git -C /src rev-parse HEAD)" = "$WALG_COMMIT" ]
WORKDIR /src
RUN CGO_ENABLED=0 GOEXPERIMENT=jsonv2 go build -trimpath -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.walgVersion=$WALG_TAG" -o /wal-g ./main/pg \
 && /wal-g --version

FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
COPY --from=walg /wal-g /usr/local/bin/wal-g
COPY walg-base.sh /usr/local/bin/walg-base.sh
