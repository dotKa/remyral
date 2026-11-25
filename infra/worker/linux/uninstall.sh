#!/usr/bin/env bash
# Remyral worker uninstaller for Linux - p2-service-linux.
#
#   sudo ./uninstall.sh            stop + remove the service, unit, bundle and CLI wrapper;
#                                  KEEP config, state, device key, workspaces and the user
#   sudo ./uninstall.sh --purge    also delete /etc/remyral-worker, /var/lib/remyral-worker
#                                  (device key => the worker must be re-paired) and the user
#
# Idempotent; --dry-run prints every action without changing anything.
set -euo pipefail

SERVICE_USER=remyral-worker
SERVICE_NAME=remyral-worker.service
UNIT_FILE=/etc/systemd/system/$SERVICE_NAME
DROPIN_DIR=/etc/systemd/system/$SERVICE_NAME.d
UPDATE_SERVICE=remyral-worker-update.service
UPDATE_PATH=remyral-worker-update.path
PREPARE_SERVICE=remyral-worker-prepare.service
PREPARE_PATH=remyral-worker-prepare.path
ADMIN_SERVICE=remyral-worker-admin.service
ADMIN_PATH=remyral-worker-admin.path
OPT_DIR=/opt/remyral-worker
ETC_DIR=/etc/remyral-worker
DATA_DIR=/var/lib/remyral-worker
CLI_WRAPPER=/usr/local/bin/remyral-worker

DRY_RUN=0
PURGE=0
while [ $# -gt 0 ]; do
  case $1 in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) printf 'uninstall.sh: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else printf '+ %s\n' "$*"; "$@"; fi
}
info() { printf '==> %s\n' "$*"; }

[ "$(uname -s)" = Linux ] || { echo "uninstall.sh: Linux only" >&2; exit 1; }
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then echo "uninstall.sh: run as root (sudo), or use --dry-run" >&2; exit 1; fi

info "Updater (p2-signed-updates)"
for u in "$ADMIN_PATH" "$ADMIN_SERVICE" "$PREPARE_PATH" "$PREPARE_SERVICE" "$UPDATE_PATH" "$UPDATE_SERVICE"; do
  if command -v systemctl >/dev/null 2>&1 && [ "$(systemctl show -p LoadState --value "$u" 2>/dev/null || true)" = loaded ]; then
    [ "$(systemctl is-active "$u" 2>/dev/null || true)" = inactive ] || run systemctl stop "$u"
    [ "$(systemctl is-enabled "$u" 2>/dev/null || true)" != enabled ] || run systemctl disable "$u"
  fi
done

info "Service"
if command -v systemctl >/dev/null 2>&1 && [ "$(systemctl show -p LoadState --value "$SERVICE_NAME" 2>/dev/null || true)" = loaded ]; then
  # A graceful stop cancels running jobs (TimeoutStopSec in the unit).
  [ "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)" = inactive ] || run systemctl stop "$SERVICE_NAME"
  [ "$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)" != enabled ] || run systemctl disable "$SERVICE_NAME"
else
  info "not loaded"
fi
removed_unit=0
for f in "$UNIT_FILE" "$DROPIN_DIR" "/etc/systemd/system/$UPDATE_SERVICE" "/etc/systemd/system/$UPDATE_PATH" "/etc/systemd/system/$PREPARE_SERVICE" "/etc/systemd/system/$PREPARE_PATH" "/etc/systemd/system/$ADMIN_SERVICE" "/etc/systemd/system/$ADMIN_PATH"; do
  if [ -e "$f" ]; then run rm -rf "$f"; removed_unit=1; fi
done
[ "$removed_unit" = 0 ] || run systemctl daemon-reload
if [ "$(systemctl show -p ActiveState --value "$SERVICE_NAME" 2>/dev/null || true)" = failed ]; then
  run systemctl reset-failed "$SERVICE_NAME"
fi

info "Program files"
for f in "$OPT_DIR" "$CLI_WRAPPER"; do
  if [ -e "$f" ]; then run rm -rf "$f"; fi
done

if [ "$PURGE" = 1 ]; then
  info "Purge: config, state, device key, workspaces, user"
  for f in "$ETC_DIR" "$DATA_DIR"; do
    if [ -e "$f" ]; then run rm -rf "$f"; fi
  done
  if getent passwd "$SERVICE_USER" >/dev/null; then
    # Kill anything still running as the worker user (an agent the daemon could not stop).
    if pgrep -u "$SERVICE_USER" >/dev/null 2>&1; then run pkill -KILL -u "$SERVICE_USER"; fi
    run userdel "$SERVICE_USER"
  fi
  if getent group "$SERVICE_USER" >/dev/null; then run groupdel "$SERVICE_USER"; fi
  echo "Purged. The master still lists this worker: revoke it in the dashboard."
else
  echo "Kept $ETC_DIR, $DATA_DIR (device key, state, workspaces) and user $SERVICE_USER; use --purge to remove them."
fi
[ "$DRY_RUN" = 0 ] || echo "(dry-run: nothing was changed)"
