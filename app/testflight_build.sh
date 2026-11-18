#!/usr/bin/env bash
# Shortcut for ./build.sh --testflight: build iOS with the "testflight"
# profile and upload it to TestFlight.
#
#   ./testflight_build.sh
#   ./testflight_build.sh "What changed in this build"   # TestFlight's "What to Test"
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# -gt 0 && -n "$1" ]]; then
  exec ./build.sh --testflight --what-to-test "$1"
fi
exec ./build.sh --testflight
