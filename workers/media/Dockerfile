# عامل الوسائط: Python 3.12 + FFmpeg 8.0.1 ثابت (بناء ساكن) مثبّتان بالبصمة.
# الاختبارات تعمل في الصورة نفسها (الهدف test) فيطابق إصدار FFmpeg في CI ما يعمل في الإنتاج.
FROM mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594 AS ffmpeg

FROM python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONPATH=/app/src
RUN useradd --system --uid 10001 --home-dir /app media
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src

FROM base AS test
COPY requirements-test.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements-test.txt
COPY tests ./tests
COPY bench ./bench
USER media
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
USER media
ENTRYPOINT ["python", "-m", "media_worker"]
