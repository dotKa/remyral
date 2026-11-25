#!/usr/bin/env bash
# Restore a Remyral backup made by infra/backup/backup.sh (p1-backups, docs/ops/backups.md §6).
# Runs wherever the owner's age identity is: the owner's Mac, or a fresh EC2 during a DR drill.
# Never on the production host as a routine — the identity must not live there.
#
#   restore.sh list     --target URI --env ENV [--kind postgres|secrets]
#   restore.sh postgres --from OBJECT --identity FILE (--fresh [--name N] [--port P] [--image IMG] | --container C)
#                       [--db remyral] [--role-prefix remyral] [--superuser postgres] [--target URI]
#   restore.sh secrets  --from OBJECT --identity FILE --out DIR [--target URI]
#
# OBJECT is s3://bucket/key.dump.age, file:///abs/key.dump.age, a plain local path, or — with --target —
# a key relative to the target, or `latest` (newest object of --env/--kind under --target).
# The manifest (<object without .dump.age/.tar.age>.manifest.json) must sit next to the object: the
# ciphertext hash is checked before decryption and the plaintext hash after it; age itself rejects any
# modified or truncated ciphertext (authenticated encryption).
#
# --fresh   starts a NEW Postgres container (same pinned image as production), creates the three
#           Remyral roles (NOLOGIN: set passwords before pointing a master at it) and restores into it.
# --role-prefix  the role names of the backed-up installation (<prefix>_owner|_app|_backup; default remyral).
# --container  restores into an existing container's database, which must be empty (no tables in
#           public) — the DR path: start only the `postgres` service of the compose project, then
#           restore, then start the rest (docs/ops/backups.md §6.3).
set -Eeuo pipefail
umask 077
LOG_TAG=remyral-restore
# shellcheck source=infra/backup/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# postgres:18.6-alpine, same digest as infra/coolify/compose.yaml.
DEFAULT_IMAGE='postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'

CMD=${1:-}
[ $# -eq 0 ] || shift
FROM='' IDENTITY='' TARGET='' ENV_NAME=prod KIND='' OUT='' FRESH=0 CONTAINER='' NAME='' PORT=''
IMAGE=$DEFAULT_IMAGE DB=remyral SUPERUSER=postgres RP=remyral
while [ $# -gt 0 ]; do
  case $1 in
    --from) FROM=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --target) TARGET=$2; shift 2 ;;
    --env) ENV_NAME=$2; shift 2 ;;
    --kind) KIND=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --container) CONTAINER=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --db) DB=$2; shift 2 ;;
    --role-prefix) RP=$2; shift 2 ;;
    --superuser) SUPERUSER=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
printf '%s' "$DB" | grep -qE '^[a-z_][a-z0-9_]{0,62}$' || die "bad --db"
printf '%s' "$SUPERUSER" | grep -qE '^[a-z_][a-z0-9_]{0,62}$' || die "bad --superuser"
printf '%s' "$RP" | grep -qE '^[a-z][a-z0-9]{0,30}$' || die "bad --role-prefix"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/remyral-restore.XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# resolve_object <kind> → sets OBJ_CT and OBJ_MANIFEST (local files)
resolve_object() {
  local kind=$1 ext key manifest_key
  if [ "$kind" = postgres ]; then ext=dump.age; else ext=tar.age; fi
  [ -n "$FROM" ] || die "--from is required"
  case $FROM in
    s3://* | file:///*)
      parse_target "$FROM"
      if [ "$TARGET_KIND" = s3 ]; then key=$TARGET_PREFIX; else key=${TARGET_ROOT#/}; TARGET_ROOT=''; fi
      ;;
    latest)
      [ -n "$TARGET" ] || die "--from latest needs --target"
      parse_target "$TARGET"
      key=$( (target_list "${TARGET_PREFIX:+$TARGET_PREFIX/}frequent/$ENV_NAME/$kind/"
        target_list "${TARGET_PREFIX:+$TARGET_PREFIX/}daily/$ENV_NAME/$kind/") |
        grep -E "\\.$ext\$" | awk -F/ '{print $NF" "$0}' | LC_ALL=C sort | tail -n 1 | cut -d' ' -f2-)
      [ -n "$key" ] || die "no $kind backup of $ENV_NAME under $TARGET"
      ;;
    /*)
      TARGET_KIND=file TARGET_ROOT='' key=${FROM#/}
      ;;
    *)
      [ -n "$TARGET" ] || die "a relative --from needs --target"
      parse_target "$TARGET"
      key="${TARGET_PREFIX:+$TARGET_PREFIX/}$FROM"
      ;;
  esac
  case $key in *".$ext") ;; *) die "$FROM is not a .$ext object" ;; esac
  if [ "$TARGET_KIND" = file ] && [ -z "$TARGET_ROOT" ]; then key="/$key"; fi
  manifest_key="${key%."$ext"}.manifest.json"
  log "fetching $key"
  target_get "$key" "$WORK/object.age"
  target_get "$manifest_key" "$WORK/manifest.json"
  OBJ_CT="$WORK/object.age"
  OBJ_MANIFEST="$WORK/manifest.json"
  [ "$(manifest_field "$OBJ_MANIFEST" format)" = "$REMYRAL_BACKUP_FORMAT" ] || die "unknown manifest format"
  [ "$(manifest_field "$OBJ_MANIFEST" kind)" = "$kind" ] || die "manifest is not a $kind backup"
  [ "$(sha256_file "$OBJ_CT")" = "$(manifest_field "$OBJ_MANIFEST" ciphertextSha256)" ] ||
    die "ciphertext hash does not match the manifest — object corrupted or substituted"
}

# decrypt → $WORK/plain, verified against the manifest's plaintext hash
decrypt_object() {
  [ -n "$IDENTITY" ] || die "--identity <age identity file> is required"
  [ -f "$IDENTITY" ] || die "$IDENTITY not found"
  need age 'brew install age / apt-get install age'
  age -d -i "$IDENTITY" -o "$WORK/plain" "$OBJ_CT" || die "decryption failed (wrong identity, or tampered/truncated ciphertext)"
  [ "$(sha256_file "$WORK/plain")" = "$(manifest_field "$OBJ_MANIFEST" plaintextSha256)" ] ||
    die "plaintext hash does not match the manifest"
  log "decrypted and verified $(file_size "$WORK/plain") bytes (created $(manifest_field "$OBJ_MANIFEST" createdAt), env $(manifest_field "$OBJ_MANIFEST" env))"
}

psql_su() { docker exec -i -u postgres "$CONTAINER" psql -U "$SUPERUSER" -d "${2:-$DB}" -X -v ON_ERROR_STOP=1 -tA -c "$1"; }

cmd_list() {
  [ -n "$TARGET" ] || die "--target is required"
  parse_target "$TARGET"
  local k
  for tier in frequent daily; do
    for k in ${KIND:-postgres secrets}; do
      target_list "${TARGET_PREFIX:+$TARGET_PREFIX/}$tier/$ENV_NAME/$k/" | grep -E '\.age$' || true
    done
  done
}

cmd_postgres() {
  need docker 'Docker is used to run Postgres and pg_restore'
  resolve_object postgres
  decrypt_object
  if [ "$FRESH" = 1 ]; then
    [ -z "$CONTAINER" ] || die "--fresh and --container are exclusive"
    NAME=${NAME:-remyral-restore-$(date -u +%Y%m%d%H%M%S)}
    local pw
    pw=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
    local publish=()
    if [ -n "$PORT" ]; then publish=(-p "127.0.0.1:$PORT:5432"); fi
    log "starting fresh Postgres container $NAME ($IMAGE)"
    POSTGRES_PASSWORD=$pw docker run -d --name "$NAME" -e POSTGRES_PASSWORD -e POSTGRES_USER=postgres \
      -e POSTGRES_DB="$DB" -e POSTGRES_INITDB_ARGS='--auth-host=scram-sha-256 --auth-local=peer' \
      ${publish[@]+"${publish[@]}"} --label remyral.restore=1 "$IMAGE" >/dev/null
    CONTAINER=$NAME
    SUPERUSER=postgres
    local i
    for i in $(seq 1 60); do
      if docker exec -u postgres "$CONTAINER" pg_isready -U postgres -d "$DB" -q 2>/dev/null &&
        psql_su 'SELECT 1' >/dev/null 2>&1; then break; fi
      [ "$i" -lt 60 ] || die "fresh Postgres did not become ready"
      sleep 1
    done
    # Same database-level setup as the compose initdb hook (pg_dump -Fc without --create does not carry
    # database ownership/ACLs or roles). NOLOGIN: give passwords explicitly before using the copy.
    docker exec -i -u postgres "$CONTAINER" psql -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE ${RP}_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE ${RP}_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE ${RP}_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
GRANT pg_read_all_data TO ${RP}_backup WITH INHERIT TRUE;
ALTER ROLE ${RP}_backup SET default_transaction_read_only = on;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER DATABASE $DB OWNER TO ${RP}_owner;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $DB TO ${RP}_app, ${RP}_backup;
ALTER SCHEMA public OWNER TO ${RP}_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${RP}_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${RP}_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RP}_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${RP}_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${RP}_app;
SQL
  else
    [ -n "$CONTAINER" ] || die "use --fresh or --container <name>"
  fi

  local tables
  tables=$(psql_su "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
  [ "$tables" = 0 ] || die "database $DB in $CONTAINER already has $tables tables; restore only into an empty database"
  # Roles referenced by the dump must exist (ownership and GRANTs are restored as in production).
  local missing
  missing=$(psql_su "SELECT string_agg(r, ',') FROM unnest(ARRAY['${RP}_owner','${RP}_app']) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)")
  [ -z "$missing" ] || die "roles missing in the target cluster: $missing (another role prefix? --role-prefix)"

  log "pg_restore into $CONTAINER/$DB (single transaction)"
  docker exec -i -u postgres "$CONTAINER" pg_restore -U "$SUPERUSER" -d "$DB" --exit-on-error \
    --single-transaction --no-password <"$WORK/plain"

  # Post-restore checks: schema version and audit head recorded at backup time.
  local mig head head_id head_hash got
  mig=$(manifest_field "$OBJ_MANIFEST" lastMigration)
  got=$(psql_su "SELECT coalesce(max(version), '') FROM schema_migrations" 2>/dev/null || true)
  [ -z "$mig" ] || [ "$got" = "$mig" ] || die "restored schema_migrations head $got != manifest $mig"
  head=$(manifest_field "$OBJ_MANIFEST" auditHead)
  head_id=${head%%:*}
  head_hash=${head#*:}
  if [ -n "$head_hash" ]; then
    printf '%s' "$head_id" | grep -qE '^[0-9]+$' || die "bad auditHead in manifest"
    printf '%s' "$head_hash" | grep -qE '^[0-9a-f]{64}$' || die "bad auditHead in manifest"
    got=$(psql_su "SELECT encode(hash, 'hex') FROM audit_events WHERE id = $head_id")
    [ "$got" = "$head_hash" ] || die "audit head $head_id from the manifest is missing or differs in the restore"
  fi
  log "restore OK: container=$CONTAINER db=$DB tables=$(psql_su "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") migration=${got:+$mig} auditHead=${head_id:-0}"
  printf '%s\n' "$CONTAINER"
}

cmd_secrets() {
  [ -n "$OUT" ] || die "--out DIR is required"
  resolve_object secrets
  decrypt_object
  mkdir -p "$OUT"
  chmod 0700 "$OUT"
  [ -z "$(ls -A "$OUT")" ] || die "$OUT is not empty"
  tar -C "$OUT" -xpf "$WORK/plain"
  log "secrets restored into $OUT (stack.env, secrets/) — modes and numeric owners preserved when run as root"
}

case $CMD in
  list) cmd_list ;;
  postgres) cmd_postgres ;;
  secrets) cmd_secrets ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
