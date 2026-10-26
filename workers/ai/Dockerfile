# عامل التفريغ المحلي (ADR 0020): Python 3.12 بالبصمة نفسها في عامل الوسائط، وfaster-whisper بالبصمات، بلا أوزان
# (الأوزان في حجم ai-models للقراءة فقط، ADR 0019). المستخدم 10002 كبيئة infra/ai/runtime، والجذر للقراءة فقط في compose.
FROM python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
# HF_HUB_OFFLINE: المكتبة لا تحاول الوصول إلى الشبكة أصلًا (والعامل بلا خروج على أي حال).
# ORT_DISABLE_TELEMETRY: onnxruntime (لـ Silero VAD) يحمل قياس استخدام إلى خادم خارجي ويبدؤه عند الاستيراد؛ يُطفأ
# قبل الاستيراد، ويُطفأ ثانية في الكود (transcribe.py). الاختبار test_no_telemetry يتحقق من الأمرين.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 ORT_DISABLE_TELEMETRY=1
RUN useradd --system --uid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin ai
WORKDIR /app
COPY requirements.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt
COPY pyproject.toml ./
COPY src ./src
COPY lexicon ./lexicon

FROM base AS test
COPY requirements-test.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements-test.txt
COPY tests ./tests
USER 10002:10002
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]

FROM base AS runtime
RUN install -d -o 10002 -g 10002 /scratch
USER 10002:10002
ENTRYPOINT ["python", "-m", "ai_worker"]
