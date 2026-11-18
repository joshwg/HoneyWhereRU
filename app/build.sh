#!/usr/bin/env bash
# Build the app with EAS.
#
#   ./build.sh                    # Android + iOS, "preview" profile
#   ./build.sh --android          # Android only
#   ./build.sh --ios              # iOS only (preview)
#   ./build.sh --testflight       # iOS via the "testflight" profile, uploaded to TestFlight
#   ./build.sh --testflight --android                   # TestFlight iOS + preview Android
#   ./build.sh --testflight --what-to-test "Quick badge"  # sets TestFlight's "What to Test"
#
# preview = internal distribution: an APK for Android, an ad-hoc iOS build,
# both installed from the EAS link / QR code. These never reach TestFlight.
# --testflight = App Store signing ("testflight" build profile), submitted
# automatically with the "testflight" submit profile once the build finishes;
# Apple then takes a few minutes to process it before it appears in TestFlight.
# Android has no store profile, so it is always a preview APK.
#
# With both platforms, iOS is started first without waiting (so any Apple
# credential prompts come up front, and a TestFlight upload is still
# scheduled), then the script follows the Android build. Each platform gets
# its own command because eas-cli only shows queue position and estimated
# wait time when following a single build. The iOS build's progress is on its
# expo.dev page, linked in the output.
set -euo pipefail
cd "$(dirname "$0")"

android=false
ios=false
testflight=false
what_to_test=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --android) android=true ;;
    --ios) ios=true ;;
    --testflight) testflight=true; ios=true ;;
    --what-to-test)
      [[ $# -ge 2 ]] || { echo "--what-to-test needs a value" >&2; exit 1; }
      what_to_test="$2"; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (expected --android, --ios, --testflight, --what-to-test \"...\")" >&2; exit 1 ;;
  esac
  shift
done
if ! $android && ! $ios; then
  android=true
  ios=true
fi
if [[ -n "$what_to_test" ]] && ! $testflight; then
  echo "--what-to-test only applies with --testflight" >&2
  exit 1
fi

ios_args=(--platform ios)
if $testflight; then
  ios_args+=(--profile testflight --auto-submit)
  [[ -n "$what_to_test" ]] && ios_args+=(--what-to-test "$what_to_test")
else
  ios_args+=(--profile preview)
fi
android_args=(--platform android --profile preview)

targets=()
if $ios; then
  if $testflight; then targets+=("iOS (TestFlight)"); else targets+=("iOS (preview)"); fi
fi
$android && targets+=("Android (preview)")
echo "Building version $(tr -d '[:space:]' < ../VERSION): ${targets[*]}"

# EAS builds run on Expo's servers, so nothing works offline -- and eas-cli's
# own error for that is a buried "fetch failed" / ENOTFOUND stack. Check that
# Expo's API is reachable first and say plainly what is wrong if it isn't.
# Any HTTP response counts as reachable; only DNS/connect/timeout failures fail.
expo_api=https://api.expo.dev
check_connectivity() {
  local rc=0
  curl -sS -o /dev/null --connect-timeout 5 --max-time 10 "$expo_api" 2>/dev/null || rc=$?
  case $rc in
    0) return 0 ;;
    6) echo "ERROR: no internet connection -- can't resolve api.expo.dev (DNS lookup failed)." >&2 ;;
    7) echo "ERROR: no internet connection -- can't connect to api.expo.dev." >&2 ;;
    28) echo "ERROR: no internet connection -- timed out reaching api.expo.dev." >&2 ;;
    *) echo "ERROR: can't reach api.expo.dev (curl exit $rc) -- check the internet connection." >&2 ;;
  esac
  echo "EAS builds run on Expo's servers, so the build needs a working connection. Reconnect and rerun." >&2
  return 1
}

# Run one eas build; if it fails, re-check connectivity so a connection that
# dropped mid-build gets the same clear message instead of eas-cli's stack.
eas_build() {
  local rc=0
  npx eas build "$@" || rc=$?
  if [[ $rc -ne 0 ]]; then
    check_connectivity || true
    exit $rc
  fi
}

check_connectivity || exit 1

if $ios && $android; then
  eas_build "${ios_args[@]}" --no-wait
  eas_build "${android_args[@]}"
elif $ios; then
  eas_build "${ios_args[@]}"
else
  eas_build "${android_args[@]}"
fi
