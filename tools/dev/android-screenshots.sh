#!/usr/bin/env bash
# لقطات اصطناعية على ثلاثة محاكيات قابلة للإزالة؛ لا تشغيل على جهاز فعلي.
set -euo pipefail
set +x
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ ${DEMO_CAPTURE_ONLY:-} == 1 ]] || { echo 'DEMO_CAPTURE_ONLY=1 required' >&2; exit 2; }
for name in SCREENSHOT_PHONE_AVD SCREENSHOT_SEVEN_AVD SCREENSHOT_TEN_AVD DEMO_CAPTURE_EMAIL DEMO_CAPTURE_PASSWORD; do
  [[ -n ${!name:-} ]] || { echo "Required setting missing: $name" >&2; exit 2; }
done
for tool in adb emulator python3 node; do
  command -v "$tool" >/dev/null || { echo "Required tool unavailable: $tool" >&2; exit 2; }
done
port=${DEMO_CAPTURE_API_PORT:-3000}
[[ $port =~ ^[0-9]+$ && $port -ge 1024 && $port -le 65535 ]] || exit 2
serial=emulator-5554
if adb devices | awk '{print $1}' | grep -qx "$serial"; then
  echo 'Emulator port already occupied; no device was modified' >&2; exit 2
fi
for avd in "$SCREENSHOT_PHONE_AVD" "$SCREENSHOT_SEVEN_AVD" "$SCREENSHOT_TEN_AVD"; do
  [[ $avd =~ ^[A-Za-z0-9_.-]+$ ]] || exit 2
  emulator -list-avds | grep -Fxq "$avd" || { echo 'Required AVD missing' >&2; exit 2; }
done
# لا ننشر لقطات قديمة إذا أخفق تشغيل جديد، ولا نستبدل لقطات راجعها المالك.
for locale in ar en-US; do
  for category in phoneScreenshots sevenInchScreenshots tenInchScreenshots; do
    target="$root/apps/android/store/metadata/android/$locale/images/$category"
    if [[ -d $target ]] && find "$target" -name '*.png' -print -quit | grep -q .; then
      echo 'Capture output already exists; archive it before a new run' >&2; exit 2
    fi
  done
done
work=$(mktemp -d)
pid=''
cleanup() {
  if [[ -n $pid ]]; then
    adb -s "$serial" shell run-as net.palpost.library rm -f files/store-capture.json >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear net.palpost.library >/dev/null 2>&1 || true
    adb -s "$serial" emu kill >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# يعيد adb reverse توجيه منفذ المضيف إلى localhost في المحاكي فقط.
export ORG_GRADLE_PROJECT_apiBaseUrl="http://localhost:$port/v1"
(cd "$root/apps/android" && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest)
app="$root/apps/android/app/build/outputs/apk/debug/app-debug.apk"
testapk="$root/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
index=0
for category in phoneScreenshots sevenInchScreenshots tenInchScreenshots; do
  case "$category" in
    phoneScreenshots) avd=$SCREENSHOT_PHONE_AVD; size=1080x1920; density=420 ;;
    sevenInchScreenshots) avd=$SCREENSHOT_SEVEN_AVD; size=1200x1920; density=320 ;;
    tenInchScreenshots) avd=$SCREENSHOT_TEN_AVD; size=1600x2560; density=300 ;;
  esac
  emulator -avd "$avd" -port 5554 -no-window -no-audio -no-snapshot -wipe-data >"$work/emulator.log" 2>&1 &
  pid=$!
  ready=0
  for ((attempt=0; attempt<180; attempt++)); do
    kill -0 "$pid" 2>/dev/null || { echo 'Emulator exited' >&2; exit 1; }
    if [[ $(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then ready=1; break; fi
    sleep 1
  done
  [[ $ready == 1 ]] || { echo 'Emulator boot timed out' >&2; exit 1; }
  [[ $(adb -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r') == 1 ]] || exit 2
  adb -s "$serial" shell wm size "$size"
  adb -s "$serial" shell wm density "$density"
  adb -s "$serial" shell settings put system accelerometer_rotation 0
  adb -s "$serial" shell settings put system user_rotation 0
  adb -s "$serial" shell settings put global window_animation_scale 0
  adb -s "$serial" shell settings put global transition_animation_scale 0
  adb -s "$serial" shell settings put global animator_duration_scale 0
  adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
  adb -s "$serial" shell wm dismiss-keyguard
  adb -s "$serial" reverse "tcp:$port" "tcp:$port"
  for locale in ar en-US; do
    adb -s "$serial" install -r "$app" >/dev/null
    adb -s "$serial" install -r "$testapk" >/dev/null
    adb -s "$serial" shell pm clear net.palpost.library >/dev/null
    adb -s "$serial" shell run-as net.palpost.library mkdir -p files
    # الاعتمادات عبر stdin إلى ملف خاص مؤقت؛ لا argv ولا سجل ولا ملف على المضيف.
    python3 -c 'import json,os; print(json.dumps({"synthetic":True,"email":os.environ["DEMO_CAPTURE_EMAIL"],"password":os.environ["DEMO_CAPTURE_PASSWORD"]}))' |
      adb -s "$serial" shell run-as net.palpost.library sh -c '"cat > files/store-capture.json"'
    adb -s "$serial" shell am instrument -w -r \
      -e class net.palpost.library.StoreScreenshotsTest -e storeCapture 1 -e captureLocale "$locale" \
      net.palpost.library.test/androidx.test.runner.AndroidJUnitRunner >"$work/instrumentation.log" 2>&1
    # adb قد يخرج 0 حتى عند فشل الاختبار؛ لا يكفي كود العملية.
    grep -Fq 'OK (1 test)' "$work/instrumentation.log" || { echo 'Capture instrumentation failed; no output published' >&2; exit 1; }
    out="$work/$locale/$category"
    mkdir -p "$out"
    for screen in 01-home 02-materials 03-new-material 04-uploads 05-notifications; do
      adb -s "$serial" exec-out run-as net.palpost.library cat "files/store-captures/$screen.png" >"$out/$screen.png"
    done
    python3 "$root/tools/dev/check-android-screenshots.py" "$out" "$size"
    adb -s "$serial" shell pm clear net.palpost.library >/dev/null
    index=$((index+1))
  done
  adb -s "$serial" emu kill >/dev/null
  wait "$pid" 2>/dev/null || true
  pid=''
done
[[ $index == 6 ]] || exit 1
# لا نسخ للمتجر إلا بعد اكتمال المصفوفة والتحقق من ملفاتها الثلاثين.
for locale in ar en-US; do
  for category in phoneScreenshots sevenInchScreenshots tenInchScreenshots; do
    dest="$root/apps/android/store/metadata/android/$locale/images/$category"
    mkdir -p "$dest"
    cp "$work/$locale/$category/"*.png "$dest/"
  done
done
node "$root/tools/dev/write-android-screenshots.mjs" "$started"
echo 'Captured 30 synthetic screenshots; owner visual review still required.'
