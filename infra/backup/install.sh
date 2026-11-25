#!/usr/bin/env bash
# Installs the backup timer for one environment on the control-plane host (p1-backups,
# docs/ops/backups.md §4). Idempotent; run from the rsynced source tree as root:
#
#   sudo infra/backup/install.sh --env prod --target s3://<bucket>/remyral --region us-west-2 \
#        --expected-owner <backup account id> --recipients /path/to/recipients.txt [--dry-run]
#
# Installs age if missing (AWS CLI v2 must already be installed), copies backup.sh/lib.sh to /usr/local/lib/remyral-backup,
# writes /etc/remyral/backup/<env>.env (no secrets in it) and recipients.txt (public keys only),
# enables remyral-backup@<env>.timer. Does NOT create the DB role password: see §3.
set -Eeuo pipefail
umask 022
LOG_TAG=remyral-backup-install
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/backup/lib.sh
. "$HERE/lib.sh"

ENV_NAME='' TARGET='' REGION='' OWNER_ID='' RECIP='' CW_NS='Remyral/Backup' DRY=0 ENDPOINT='' CREDS=''
while [ $# -gt 0 ]; do
  case $1 in
    --env) ENV_NAME=$2; shift 2 ;;
    --target) TARGET=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --expected-owner) OWNER_ID=$2; shift 2 ;;
    --recipients) RECIP=$2; shift 2 ;;
    --cloudwatch-namespace) CW_NS=$2; shift 2 ;;
    --endpoint) ENDPOINT=$2; shift 2 ;;
    --credentials) CREDS=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
printf '%s' "$ENV_NAME" | grep -qE '^[a-z][a-z0-9-]{0,30}$' || die "--env prod|staging is required"
parse_target "${TARGET:?--target is required}"
[ "$TARGET_KIND" != s3 ] || [ -n "$REGION" ] || die "--region is required for s3 targets"
[ -z "$OWNER_ID" ] || printf '%s' "$OWNER_ID" | grep -qE '^[0-9]{12}$' || die "--expected-owner must be a 12-digit account id"
check_recipients_file "${RECIP:?--recipients is required}"

step() {
  if [ "$DRY" = 1 ]; then printf 'DRY-RUN: %s\n' "$*"; else log "$*"; "$@"; fi
}

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root"
if ! command -v age >/dev/null 2>&1; then step apt-get install -y age; fi
if [ "$TARGET_KIND" = s3 ]; then
  # AWS CLI v2 via the official, signature-checked installer (docs/ops/backups.md §4). Not the snap:
  # snap-confine does not run under the unit's NoNewPrivileges/ProtectSystem sandbox.
  command -v aws >/dev/null 2>&1 || [ "$DRY" = 1 ] || die "AWS CLI v2 missing: install it first (docs/ops/backups.md §4)"
  case $(aws --version 2>/dev/null || echo 'aws-cli/2.dry') in aws-cli/2.*) ;; *) die "AWS CLI v2 required" ;; esac
fi
step install -d -m 0755 /usr/local/lib/remyral-backup
step install -m 0755 "$HERE/backup.sh" /usr/local/lib/remyral-backup/backup.sh
step install -m 0644 "$HERE/lib.sh" /usr/local/lib/remyral-backup/lib.sh
step install -d -m 0700 /etc/remyral/backup "/var/lib/remyral-backup/$ENV_NAME"
step install -m 0644 "$RECIP" /etc/remyral/backup/recipients.txt

CONF=$(mktemp)
trap 'rm -f "$CONF"' EXIT
{
  printf 'BACKUP_ENV=%s\n' "$ENV_NAME"
  printf 'BACKUP_TARGET=%s\n' "$TARGET"
  [ -z "$REGION" ] || printf 'BACKUP_S3_REGION=%s\n' "$REGION"
  [ -z "$OWNER_ID" ] || printf 'BACKUP_S3_EXPECTED_OWNER=%s\n' "$OWNER_ID"
  [ -z "$ENDPOINT" ] || printf 'BACKUP_S3_ENDPOINT=%s\n' "$ENDPOINT"
  [ -z "$CREDS" ] || printf 'BACKUP_S3_CREDENTIALS_FILE=%s\n' "$CREDS"
  printf 'BACKUP_RECIPIENTS_FILE=/etc/remyral/backup/recipients.txt\n'
  printf 'BACKUP_STACK_ENV=/data/remyral/%s/stack.env\n' "$ENV_NAME"
  printf 'BACKUP_SECRETS_BASE=/data/remyral/%s\n' "$ENV_NAME"
  printf 'BACKUP_STATE_DIR=/var/lib/remyral-backup/%s\n' "$ENV_NAME"
  [ -z "$CW_NS" ] || printf 'BACKUP_CLOUDWATCH_NAMESPACE=%s\n' "$CW_NS"
} >"$CONF"
if [ "$DRY" = 1 ]; then sed 's/^/DRY-RUN:   /' "$CONF"; fi
step install -m 0600 "$CONF" "/etc/remyral/backup/$ENV_NAME.env"
step install -m 0644 "$HERE/systemd/remyral-backup@.service" /etc/systemd/system/remyral-backup@.service
step install -m 0644 "$HERE/systemd/remyral-backup@.timer" /etc/systemd/system/remyral-backup@.timer
step systemctl daemon-reload
step systemctl enable --now "remyral-backup@$ENV_NAME.timer"
[ "$DRY" = 1 ] || log "installed. First run now: sudo systemctl start remyral-backup@$ENV_NAME.service && journalctl -u remyral-backup@$ENV_NAME -n 20"
