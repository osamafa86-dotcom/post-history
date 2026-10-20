# Ubuntu 24.04 للفحص الجاف لـ bootstrap.sh: الحزم تُثبَّت عند البناء، والفحص يعمل بـ --network none.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
      openssl age git ca-certificates && rm -rf /var/lib/apt/lists/*
