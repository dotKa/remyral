#!/usr/bin/env bash
# Waits (inside the test container) until systemd has booted and remyral-worker is active.
set -euo pipefail
for _ in $(seq 1 150); do
  if [ "$(systemctl is-active remyral-worker.service 2>/dev/null)" = active ]; then exit 0; fi
  sleep 0.2
done
echo "remyral-worker.service did not become active" >&2
systemctl status remyral-worker.service --no-pager >&2 || true
exit 1
