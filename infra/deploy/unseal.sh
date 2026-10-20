#!/usr/bin/env bash
# يفك أسرار التجربة إلى tmpfs (SEC-05): /etc/post-history/trial.env.age بمفتاح المضيف إلى /run/post-history/trial.env
# (root، 0400). يعمل في كل إقلاع (ExecStartPre في وحدة post-history-trial) وفي bootstrap.sh. لا يطبع قيمة.
# UNSEAL_ETC وUNSEAL_RUN للفحص الجاف فقط.
set -euo pipefail
ETC="${UNSEAL_ETC:-/etc/post-history}" RUN="${UNSEAL_RUN:-/run/post-history}"
umask 077
install -d -m 0700 "$RUN"
age -d -i "$ETC/host.agekey" -o "$RUN/trial.env.part" "$ETC/trial.env.age"
chmod 0400 "$RUN/trial.env.part"
mv -f "$RUN/trial.env.part" "$RUN/trial.env"
echo "unsealed: $RUN/trial.env ($(grep -c '=' "$RUN/trial.env") keys)"
