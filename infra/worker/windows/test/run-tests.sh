#!/usr/bin/env bash
# Runs the Windows installer plan tests under PowerShell 7 in Docker (no Windows needed).
# On Windows: powershell -NoProfile -File infra\worker\windows\test\Install.Tests.ps1
# infra/worker is mounted whole: the tests also read the shared Node pin (infra/worker/node/pin.env).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORKER_DIR=$(cd "$HERE/../.." && pwd)
docker build -q -t remyral-worker-pwsh-test "$HERE" >/dev/null
docker run --rm -v "$WORKER_DIR:/iw:ro" remyral-worker-pwsh-test -File /iw/windows/test/Install.Tests.ps1
