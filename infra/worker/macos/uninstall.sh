#!/bin/bash
# Remyral worker uninstaller for macOS - p2-service-macos.
#
#   sudo ./uninstall.sh            unload + remove the LaunchDaemon, program and CLI wrapper;
#                                  KEEP config, state, device key, workspaces, logs and the account
#   sudo ./uninstall.sh --purge    also delete /Library/Application Support/RemyralWorker,
#                                  /Library/Logs/RemyralWorker and the _remyralworker account
#                                  (device key => the worker must be re-paired)
#
# Idempotent; --dry-run prints every action without changing anything.
set -euo pipefail

SERVICE_USER=_remyralworker
LABEL=com.remyral.worker
BASE_DIR="/Library/Application Support/RemyralWorker"
LOG_DIR=/Library/Logs/RemyralWorker
PLIST=/Library/LaunchDaemons/$LABEL.plist
UPDATER_LABEL=com.remyral.worker.updater
UPDATER_PLIST=/Library/LaunchDaemons/$UPDATER_LABEL.plist
ADMIN_LABEL=com.remyral.worker.admin
ADMIN_PLIST=/Library/LaunchDaemons/$ADMIN_LABEL.plist
CLI_WRAPPER=/usr/local/bin/remyral-worker

DRY_RUN=0
PURGE=0
while [ $# -gt 0 ]; do
  case $1 in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) printf 'uninstall.sh: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

show_cmd() {
  local out="" a
  for a in "$@"; do
    case $a in
      *[!A-Za-z0-9_./:=@%+,-]* | "") out="$out '${a//\'/\'\\\'\'}'" ;;
      *) out="$out $a" ;;
    esac
  done
  printf '%s' "${out# }"
}
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$(show_cmd "$@")"; else printf '+ %s\n' "$(show_cmd "$@")"; "$@"; fi
}
info() { printf '==> %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || { echo "uninstall.sh: macOS only" >&2; exit 1; }
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then echo "uninstall.sh: run as root (sudo), or use --dry-run" >&2; exit 1; fi

info "Updater LaunchDaemon (p2-signed-updates)"
if launchctl print "system/$ADMIN_LABEL" >/dev/null 2>&1; then run launchctl bootout "system/$ADMIN_LABEL"; fi
if [ -e "$ADMIN_PLIST" ]; then run rm -f "$ADMIN_PLIST"; fi
if launchctl print "system/$UPDATER_LABEL" >/dev/null 2>&1; then run launchctl bootout "system/$UPDATER_LABEL"; fi
if [ -e "$UPDATER_PLIST" ]; then run rm -f "$UPDATER_PLIST"; fi

info "LaunchDaemon"
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  # bootout sends SIGTERM and waits up to ExitTimeOut: running jobs are cancelled gracefully.
  run launchctl bootout "system/$LABEL"
else
  info "not loaded"
fi
if [ -e "$PLIST" ]; then run rm -f "$PLIST"; fi

info "Program files"
if [ -e "$BASE_DIR/bin" ]; then run rm -rf "$BASE_DIR/bin"; fi
# p5-worker-onboarding: the private pinned Node and the kept installer kit.
for d in "$BASE_DIR/node" "$BASE_DIR/installer"; do
  if [ -e "$d" ]; then run rm -rf "$d"; fi
done
if [ -f "$CLI_WRAPPER" ] && grep -q 'infra/worker/macos/install.sh' "$CLI_WRAPPER" 2>/dev/null; then
  run rm -f "$CLI_WRAPPER"
fi

if [ "$PURGE" = 1 ]; then
  info "Purge: config, state, device key, workspaces, logs, account"
  if [ -e "$BASE_DIR" ]; then run rm -rf "$BASE_DIR"; fi
  if [ -e "$LOG_DIR" ]; then run rm -rf "$LOG_DIR"; fi
  if dscl . -read "/Users/$SERVICE_USER" >/dev/null 2>&1; then
    # Anything still running as the role account (an agent the daemon could not stop).
    if pgrep -u "$SERVICE_USER" >/dev/null 2>&1; then run pkill -KILL -u "$SERVICE_USER"; fi
    run dscl . -delete "/Users/$SERVICE_USER"
  fi
  if dscl . -read "/Groups/$SERVICE_USER" >/dev/null 2>&1; then run dscl . -delete "/Groups/$SERVICE_USER"; fi
  echo "Purged. The master still lists this worker: revoke it in the dashboard."
else
  echo "Kept $BASE_DIR (config, device key, state, workspaces), $LOG_DIR and account $SERVICE_USER; use --purge to remove them."
fi
[ "$DRY_RUN" = 0 ] || echo "(dry-run: nothing was changed)"
