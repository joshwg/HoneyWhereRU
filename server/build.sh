#!/usr/bin/env bash
# Build the server binary for Linux, stamping the version from ../VERSION
# (the same file app/app.config.js reads, so app and server stay in step).
#
#   ./build.sh          # amd64 (standard EC2)
#   ./build.sh arm64    # Graviton
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${1:-amd64}"
VERSION="$(tr -d '[:space:]' < ../VERSION)"

GOOS=linux GOARCH="$ARCH" go build -ldflags "-X main.version=$VERSION" -o whereru-server .
echo "built whereru-server $VERSION (linux/$ARCH)"
