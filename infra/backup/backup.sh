#!/usr/bin/env bash
# Off-host encrypted backup of one Remyral environment (p1-backups, docs/ops/backups.md).
#
#   backup.sh [--config FILE] [--dry-run]
#
# Runs on the control-plane host as root from the systemd timer remyral-backup@<env>.timer every 15 min:
#   1. pg_dump -Fc as the read-only role remyral_backup, executed INSIDE the environment's Postgres
#      container (pg_dump version == server version), streamed — never written to disk in plaintext —
#      through `age` to the owner's PUBLIC key(s). The server cannot decrypt its own backups.
#   2. A plaintext manifest (hashes, sizes, versions, last migration, audit head) next to each object.
#   3. The recovery secrets (stack.env + secrets/) as an encrypted tar, when they changed or once a day.
#   4. Create-only upload (S3 If-None-Match / no-clobber file target), then a success marker for alerting.
#
# Config (KEY=value, read without evaluation; default /etc/remyral/backup/${REMYRAL_ENV:-prod}.env):
#   BACKUP_ENV                  prod | staging (names the compose project remyral-<env> and the key path)
#   BACKUP_TARGET               s3://bucket/prefix | file:///abs/path
#   BACKUP_S3_REGION            region of the bucket (e.g. us-west-2) — required for s3://
#   BACKUP_S3_EXPECTED_OWNER    12-digit backup account id (requests fail if the bucket is someone else's)
#   BACKUP_RECIPIENTS_FILE      age public keys, one per line (default /etc/remyral/backup/recipients.txt)
#   BACKUP_STACK_ENV            /data/remyral/<env>/stack.env (source of REMYRAL_DB_BACKUP_PASSWORD)
#   BACKUP_SECRETS_BASE         /data/remyral/<env>  — tar members are stack.env and secrets/
#   BACKUP_STATE_DIR            /var/lib/remyral-backup/<env>
#   BACKUP_COMPOSE_PROJECT      default remyral-<env> (an installation may keep its own project name)
#   BACKUP_PG_CONTAINER         optional; default: the `postgres` service of compose project BACKUP_COMPOSE_PROJECT
#   BACKUP_PG_DB                default remyral
#   BACKUP_PG_USER              default remyral_backup
#   BACKUP_CLOUDWATCH_NAMESPACE optional; publishes BackupSucceeded/BackupBytes (instance role has
#                               CloudWatchAgentServerPolicy → cloudwatch:PutMetricData)
#   BACKUP_CLOUDWATCH_REGION    default us-east-1
set -Eeuo pipefail
umask 077
LOG_TAG=remyral-backup
# shellcheck source=infra/backup/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CONFIG="/etc/remyral/backup/${REMYRAL_ENV:-prod}.env"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case $1 in
    --config) CONFIG=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

# ---------------------------------------------------------------- config

[ -f "$CONFIG" ] || die "config $CONFIG not found"
assert_not_world_writable "$CONFIG"
while IFS= read -r line || [ -n "$line" ]; do
  case $line in '' | \#*) continue ;; esac
  key=${line%%=*}
  printf '%s' "$key" | grep -qE '^BACKUP_[A-Z0-9_]+$' || die "config: unexpected line (only BACKUP_*=value allowed)"
  value=${line#*=}
  # Environment wins over the file (tests and one-off runs); the file never evaluates anything.
  if [ -z "${!key:-}" ]; then export "$key=$value"; fi
done <"$CONFIG"

ENV_NAME=${BACKUP_ENV:?BACKUP_ENV is required}
printf '%s' "$ENV_NAME" | grep -qE '^[a-z][a-z0-9-]{0,30}$' || die "bad BACKUP_ENV"
RECIPIENTS=${BACKUP_RECIPIENTS_FILE:-/etc/remyral/backup/recipients.txt}
STACK_ENV=${BACKUP_STACK_ENV:-/data/remyral/$ENV_NAME/stack.env}
SECRETS_BASE=${BACKUP_SECRETS_BASE:-/data/remyral/$ENV_NAME}
STATE_DIR=${BACKUP_STATE_DIR:-/var/lib/remyral-backup/$ENV_NAME}
PG_DB=${BACKUP_PG_DB:-remyral}
PG_USER=${BACKUP_PG_USER:-remyral_backup}
parse_target "${BACKUP_TARGET:?BACKUP_TARGET is required}"

need docker 'the Postgres container is reached with docker exec'
need age 'apt-get install age (>= 1.1)'
[ "$TARGET_KIND" != s3 ] || need aws 'AWS CLI v2'
check_recipients_file "$RECIPIENTS"
[ -f "$STACK_ENV" ] || die "$STACK_ENV not found"
PG_PASSWORD=$(dotenv_get "$STACK_ENV" REMYRAL_DB_BACKUP_PASSWORD) ||
  die "REMYRAL_DB_BACKUP_PASSWORD is not set in $STACK_ENV (docs/ops/backups.md §3)"
[ -n "$PG_PASSWORD" ] || die "REMYRAL_DB_BACKUP_PASSWORD is empty"

if [ -n "${BACKUP_PG_CONTAINER:-}" ]; then
  PG_CONTAINER=$BACKUP_PG_CONTAINER
else
  PROJECT=${BACKUP_COMPOSE_PROJECT:-remyral-$ENV_NAME}
  printf "%s" "$PROJECT" | grep -qE "^[a-z0-9][a-z0-9_-]{0,62}\$" || die "bad BACKUP_COMPOSE_PROJECT"
  PG_CONTAINER=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter 'label=com.docker.compose.service=postgres')
  [ "$(printf '%s\n' "$PG_CONTAINER" | grep -c .)" = 1 ] || die "expected exactly one running postgres container in compose project $PROJECT"
fi

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || die "another backup of $ENV_NAME is running"
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TODAY=${STAMP:0:8}
TIER=frequent
if [ "$(cat "$STATE_DIR/last-daily" 2>/dev/null || true)" != "$TODAY" ]; then TIER=daily; fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/remyral-backup.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

psql_ro() {
  PGPASSWORD=$PG_PASSWORD docker exec -i -e PGPASSWORD "$PG_CONTAINER" \
    psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -X -v ON_ERROR_STOP=1 -tA -c "$1"
}

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: env=$ENV_NAME tier=$TIER container=$PG_CONTAINER db=$PG_DB user=$PG_USER target=$BACKUP_TARGET"
  log "dry run: would upload $(object_key "$TIER" "$ENV_NAME" postgres "$STAMP" dump.age)"
  exit 0
fi

# ---------------------------------------------------------------- 1. database

SERVER_VERSION=$(psql_ro 'SHOW server_version')
LAST_MIGRATION=$(psql_ro "SELECT coalesce(max(version), '') FROM schema_migrations" 2>/dev/null || true)
# Audit head at (or just before) the dump snapshot; the restore checks it is present in the restored DB.
AUDIT_HEAD=$(psql_ro "SELECT coalesce(max(id)::text, '0') || ':' || coalesce(encode((SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1), 'hex'), '') FROM audit_events" 2>/dev/null || echo '0:')
DUMP_VERSION=$(docker exec "$PG_CONTAINER" pg_dump --version | sed -E 's/^pg_dump \(PostgreSQL\) //')

DUMP_CT="$WORK/db.dump.age"
# The plaintext only exists inside this pipe. pipefail turns any pg_dump/age failure into an error.
PGPASSWORD=$PG_PASSWORD docker exec -i -e PGPASSWORD "$PG_CONTAINER" \
  pg_dump -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -Fc -Z 6 --no-password --lock-wait-timeout=60s \
  | tee >(sha256_stdin >"$WORK/plain.sha256") >(wc -c | tr -d ' ' >"$WORK/plain.size") \
  | age -e -R "$RECIPIENTS" -o "$DUMP_CT"
# Process substitutions finish asynchronously; wait for their outputs.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -s "$WORK/plain.sha256" ] && [ -s "$WORK/plain.size" ]; then break; fi
  sleep 0.2
done
PLAIN_SHA=$(cat "$WORK/plain.sha256")
PLAIN_SIZE=$(cat "$WORK/plain.size")
printf '%s' "$PLAIN_SHA" | grep -qE '^[0-9a-f]{64}$' || die "could not hash the dump stream"
[ "$PLAIN_SIZE" -gt 0 ] || die "pg_dump produced no output"

write_manifest() { # <out> <kind> <key> <ciphertext> <plain sha> <plain size> [extra "key": "value" lines]
  local out=$1 kind=$2 key=$3 ct=$4 psha=$5 psize=$6
  shift 6
  {
    printf '{\n'
    printf '  "format": "%s",\n' "$REMYRAL_BACKUP_FORMAT"
    printf '  "kind": "%s",\n' "$kind"
    printf '  "env": "%s",\n' "$ENV_NAME"
    printf '  "tier": "%s",\n' "$TIER"
    printf '  "createdAt": "%s",\n' "$STAMP"
    printf '  "object": "%s",\n' "$key"
    printf '  "encryption": "age",\n'
    printf '  "ciphertextSha256": "%s",\n' "$(sha256_file "$ct")"
    printf '  "ciphertextBytes": %s,\n' "$(file_size "$ct")"
    printf '  "plaintextSha256": "%s",\n' "$psha"
    printf '  "plaintextBytes": %s,\n' "$psize"
    while [ $# -gt 0 ]; do printf '  %s,\n' "$1"; shift; done
    printf '  "recipients": %s\n' "$(grep -E '^(age1|ssh-ed25519 )' "$RECIPIENTS" | cut -d' ' -f1-2 |
      sed -e 's/"//g' -e 's/.*/"&"/' | paste -sd, - | sed -e 's/^/[/' -e 's/$/]/')"
    printf '}\n'
  } >"$out"
}

sanitize() { printf '%s' "$1" | tr -cd 'A-Za-z0-9 ._:()-'; }
DB_KEY=$(object_key "$TIER" "$ENV_NAME" postgres "$STAMP" dump.age)
write_manifest "$WORK/db.manifest.json" postgres "$DB_KEY" "$DUMP_CT" "$PLAIN_SHA" "$PLAIN_SIZE" \
  "\"database\": \"$(sanitize "$PG_DB")\"" \
  "\"serverVersion\": \"$(sanitize "$SERVER_VERSION")\"" \
  "\"pgDumpVersion\": \"$(sanitize "$DUMP_VERSION")\"" \
  "\"lastMigration\": \"$(sanitize "$LAST_MIGRATION")\"" \
  "\"auditHead\": \"$(sanitize "$AUDIT_HEAD")\""

target_put "$DUMP_CT" "$DB_KEY" application/octet-stream
target_put "$WORK/db.manifest.json" "${DB_KEY%.dump.age}.manifest.json" application/json
log "postgres $ENV_NAME/$PG_DB → $DB_KEY ($(file_size "$DUMP_CT") bytes encrypted, migration ${LAST_MIGRATION:-none})"

# ---------------------------------------------------------------- 2. recovery secrets

# Content fingerprint over (path, mode, owner, sha256) of every file: upload when it changes, and daily.
secrets_fingerprint() {
  (cd "$SECRETS_BASE" && find stack.env secrets -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s %s %s\n' "$f" "$(stat -c '%a:%u:%g' "$f" 2>/dev/null || stat -f '%Lp:%u:%g' "$f")" "$(sha256_file "$f")"
  done) | sha256_stdin
}
SECRETS_UPLOADED=no
if [ -f "$SECRETS_BASE/stack.env" ] || [ -d "$SECRETS_BASE/secrets" ]; then
  FP=$(secrets_fingerprint)
  if [ "$TIER" = daily ] || [ "$(cat "$STATE_DIR/last-secrets" 2>/dev/null || true)" != "$FP" ]; then
    MEMBERS=''
    [ ! -f "$SECRETS_BASE/stack.env" ] || MEMBERS='stack.env'
    [ ! -d "$SECRETS_BASE/secrets" ] || MEMBERS="$MEMBERS secrets"
    SEC_CT="$WORK/secrets.tar.age"
    # shellcheck disable=SC2086 # MEMBERS is a fixed list of two literal names
    tar -C "$SECRETS_BASE" --numeric-owner -cf - $MEMBERS |
      tee >(sha256_stdin >"$WORK/sec.sha256") >(wc -c | tr -d ' ' >"$WORK/sec.size") |
      age -e -R "$RECIPIENTS" -o "$SEC_CT"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [ -s "$WORK/sec.sha256" ] && [ -s "$WORK/sec.size" ]; then break; fi
      sleep 0.2
    done
    SEC_KEY=$(object_key "$TIER" "$ENV_NAME" secrets "$STAMP" tar.age)
    write_manifest "$WORK/sec.manifest.json" secrets "$SEC_KEY" "$SEC_CT" "$(cat "$WORK/sec.sha256")" \
      "$(cat "$WORK/sec.size")" "\"fingerprint\": \"$FP\""
    target_put "$SEC_CT" "$SEC_KEY" application/octet-stream
    target_put "$WORK/sec.manifest.json" "${SEC_KEY%.tar.age}.manifest.json" application/json
    printf '%s\n' "$FP" >"$STATE_DIR/last-secrets"
    SECRETS_UPLOADED=yes
    log "secrets $ENV_NAME → $SEC_KEY"
  fi
else
  log "WARNING: no stack.env or secrets/ under $SECRETS_BASE — recovery secrets not backed up"
fi

# ---------------------------------------------------------------- 3. success marker / metrics

[ "$TIER" != daily ] || printf '%s\n' "$TODAY" >"$STATE_DIR/last-daily"
date -u +%s >"$STATE_DIR/last-success"
printf '%s\n' "$DB_KEY" >"$STATE_DIR/last-object"
if [ -n "${BACKUP_CLOUDWATCH_NAMESPACE:-}" ]; then
  # Instance-role credentials for CloudWatch even when the backup target uses Garage keys (lib.sh s3_env).
  env -u AWS_PROFILE -u AWS_SHARED_CREDENTIALS_FILE -u AWS_EC2_METADATA_DISABLED \
    aws cloudwatch put-metric-data --region "${BACKUP_CLOUDWATCH_REGION:-us-east-1}" \
    --namespace "$BACKUP_CLOUDWATCH_NAMESPACE" --no-cli-pager \
    --metric-data "MetricName=BackupSucceeded,Value=1,Unit=Count,Dimensions=[{Name=Env,Value=$ENV_NAME}]" \
    "MetricName=BackupBytes,Value=$(file_size "$DUMP_CT"),Unit=Bytes,Dimensions=[{Name=Env,Value=$ENV_NAME}]" ||
    log "WARNING: CloudWatch metric not published"
fi
log "done: tier=$TIER secrets=$SECRETS_UPLOADED"
