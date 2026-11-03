# عامل الوسائط: Python 3.12 + FFmpeg 8.0.1 ثابت (بناء ساكن) مثبّتان بالبصمة.
# الاختبارات تعمل في الصورة نفسها (الهدف test) فيطابق إصدار FFmpeg في CI ما يعمل في الإنتاج.
FROM mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594 AS ffmpeg

# c2patool لتوقيع C2PA (ADR 0060): من crates.io بإصدار مثبّت واعتماديات مقفلة ببصماتها (--locked). OpenSSL يُبنى من
# مصدره داخل الحزمة فيلزمه make وperl
FROM rust:1.97-slim-trixie@sha256:8e8cf8f7fd54a2d23d5a743b3a03f56e26b6c774276c33fa0595111704ebb15c AS c2patool
RUN apt-get update && apt-get install -y --no-install-recommends make perl && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --root /out c2patool@0.28.2

# ---- نسخ قالب «مواد متداولة» (ADR 0091): Node وحزمة القالب والمتصفح لهدف render وحده؛ الاختبار والتشغيل لا يحملانها.
# Node 22 من أرشيف nodejs.org، يُتحقق من بصمته قبل فكّه
FROM python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS node
ARG NODE_VERSION=22.22.0
ARG NODE_SHA256=c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744
ADD https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz /tmp/node.tar.gz
RUN echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 --no-same-owner \
 && rm -rf /tmp/node.tar.gz /opt/node/include /opt/node/share
ENV PATH=/opt/node/bin:$PATH

# Chrome Headless Shell 157.0.8080.0، النسخة التي يختبرها Remotion 4.0.537 ويقاس عليها الناتج. مخبوز في الصورة ببصمته:
# وقت التشغيل لا تنزيل ولا ensureBrowser، وتغيير النسخة تغيير في الناتج يعيد القياس (ADR 0091 البند 5)
FROM python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS chrome
ARG CHROME_SHA256=7c4a2751b361aeb3cff3ed788fa18b7a0849371b983d478bb9205b6cc25a8c52
ADD https://remotion.media/chromium-headless-shell-linux-x64-157.0.8080.0.zip /tmp/chrome.zip
RUN echo "${CHROME_SHA256}  /tmp/chrome.zip" | sha256sum -c - \
 && python -m zipfile -e /tmp/chrome.zip /opt \
 && mv /opt/chrome-headless-shell-linux64 /opt/chrome-headless-shell \
 && chmod 0755 /opt/chrome-headless-shell/chrome-headless-shell && rm /tmp/chrome.zip

# حزمة القالب مجمّعة وقت البناء من سياق البناء المسمّى `template` (مشروع التصميم بقفله):
#   docker build --target render --build-context template=docs/design/redesign-2026-11/motion/circulated-template workers/media
# اسم المرحلة غير اسم السياق: السياق المسمّى يحل محل مرحلة باسمه
FROM node AS template-bundle
WORKDIR /template
COPY --from=template package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=template src ./src
COPY --from=template public ./public
RUN npx remotion bundle src/index.ts --out-dir /bundle --log=error

# المرسِم وحده (@remotion/renderer ومُركِّبه للنظام) بقفله؛ بلا المجمِّع ولا Studio
FROM node AS overlay-deps
WORKDIR /render
COPY render/package.json render/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/@remotion/compositor-linux-x64-musl

FROM python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=c2patool /out/bin/c2patool /usr/local/bin/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONPATH=/app/src
RUN useradd --system --uid 10001 --home-dir /app media
WORKDIR /app
COPY requirements.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt
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
# قرص مؤقت للتنزيل والنسخ الخفيفة؛ يُركَّب حجمًا في compose
RUN install -d -o media -g media /scratch
USER media
ENTRYPOINT ["python", "-m", "media_worker"]
CMD ["serve"]

# حاوية media-render (ADR 0091): العامل نفسه على طابور media:renders، والطبقة من حزمة القالب بالمتصفح المثبّت.
# مكتبات المتصفح من النظام: ما يربط به Headless Shell (nss وnspr وexpat) ومكتبة ++C للمُركِّب. لا خطوط من النظام
FROM runtime AS render
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3 libnspr4 libexpat1 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /opt/node /opt/node
COPY --from=chrome /opt/chrome-headless-shell /opt/chrome-headless-shell
COPY --from=overlay-deps /render/node_modules /app/render/node_modules
COPY --from=template-bundle /bundle /app/render/bundle
COPY render/package.json render/overlay.mjs /app/render/
# يُغلق عند العطل: لا مكتبة ناقصة للمتصفح ولا للمُركِّب
RUN ! ldd /opt/chrome-headless-shell/chrome-headless-shell /app/render/node_modules/@remotion/compositor-linux-x64-gnu/remotion \
      | grep "not found"
USER media
CMD ["serve", "--queue", "renders"]
