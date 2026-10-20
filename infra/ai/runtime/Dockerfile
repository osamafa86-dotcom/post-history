# بيئة تشغيل المسار المحلي للذكاء الاصطناعي (ADR 0019): whisper.cpp مبنيًا من إيداع مثبّت، بلا أوزان (الأوزان في حجم
# ai-models ببصمات infra/ai/models.lock). الهدف runtime للمعالج (الافتراضي)، والهدف runtime-cuda للمعالج الرسومي.
# صورة دنيا للتشغيل والقياس إلى أن تحل محلها صورة workers/ai (AI_WORKER_IMAGE) دون تغيير compose.
ARG WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS src
ARG WHISPER_COMMIT
RUN apt-get update -q && apt-get install -y -q --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# الإيداع بعينه (v1.9.5): git يتحقق من المحتوى بالبصمة، والفحص يرفض أي مرجع آخر.
RUN git init -q /src && git -C /src fetch -q --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_COMMIT" \
 && git -C /src checkout -q FETCH_HEAD && test "$(git -C /src rev-parse HEAD)" = "$WHISPER_COMMIT"

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS build
RUN apt-get update -q && apt-get install -y -q --no-install-recommends cmake g++ make && rm -rf /var/lib/apt/lists/*
COPY --from=src /src /src
# GGML_NATIVE=OFF: الثنائي يعمل على أي معالج x86-64 حديث، لا على مشغّل البناء وحده.
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS runtime
RUN apt-get update -q && apt-get install -y -q --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin ai
COPY --from=build /build/bin/whisper-cli /usr/local/bin/whisper-cli
USER 10002:10002
ENTRYPOINT ["whisper-cli"]

# المعالج الرسومي (اختياري، infra/ai/compose.gpu.yml): غير مبني ولا مختبر في CI (لا معالج رسومي على المشغّل).
FROM nvidia/cuda:12.9.1-devel-ubuntu24.04@sha256:020bc241a628776338f4d4053fed4c38f6f7f3d7eb5919fecb8de313bb8ba47c AS build-cuda
RUN apt-get update -q && apt-get install -y -q --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
COPY --from=src /src /src
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_CUDA=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli

FROM nvidia/cuda:12.9.1-runtime-ubuntu24.04@sha256:1287141d283b8f06f45681b56a48a85791398c615888b1f96bfb9fc981392d98 AS runtime-cuda
RUN apt-get update -q && apt-get install -y -q --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin ai
COPY --from=build-cuda /build/bin/whisper-cli /usr/local/bin/whisper-cli
USER 10002:10002
ENTRYPOINT ["whisper-cli"]
