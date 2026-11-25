# shellcheck shell=bash
# Shared helpers for infra/backup/backup.sh and infra/backup/restore.sh (p1-backups,
# docs/ops/backups.md). Sourced, never executed. Bash 3.2 compatible (macOS /bin/bash).
#
# Storage targets ("the same interface" for production and the local round-trip test):
#   s3://<bucket>/<prefix>   AWS CLI v2, credentials from the instance role (IMDSv2). Create-only:
#                            every PUT is conditional (If-None-Match: *), so nothing is ever overwritten.
#   file:///<abs path>       A directory tree with the same keys; create-only as well. Used by
#                            `pnpm e2e:backup` and for an extra copy on removable media.

REMYRAL_BACKUP_FORMAT='remana-backup/v1'

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-remyral-backup}" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 ($2)"; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}
sha256_file() { sha256_stdin <"$1"; }
file_size() { wc -c <"$1" | tr -d ' '; }

# Reads KEY from a dotenv-style file without evaluating it (values may contain `$`, quotes are stripped).
dotenv_get() {
  local file=$1 key=$2 line value
  line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
  [ -n "$line" ] || return 1
  value=${line#*=}
  case $value in
    \"*\") value=${value#\"} value=${value%\"} ;;
    \'*\') value=${value#\'} value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

# Refuses files that others can write (config) or read (secrets) — mirrors sign.mjs's key check.
assert_not_world_writable() {
  local mode
  mode=$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1")
  case $mode in
    *[2367]? | *[2367]) die "$1 is group/other-writable (mode $mode)" ;;
  esac
}

# ---------------------------------------------------------------- age recipients / identities

# A recipients file holds only public keys (age1… or ssh-ed25519 …) and comments. Any private key
# material on the backup host defeats the design (the server must not be able to decrypt), so refuse.
check_recipients_file() {
  local f=$1 n
  [ -s "$f" ] || die "recipients file $f is missing or empty"
  if grep -q 'AGE-SECRET-KEY-' "$f" || grep -q 'PRIVATE KEY' "$f"; then
    die "$f contains a PRIVATE key; only public recipients belong on the server (docs/ops/backups.md §2)"
  fi
  if grep -vE '^[[:space:]]*(#.*)?$' "$f" | grep -vqE '^(age1[0-9a-z]{58}|ssh-ed25519 [A-Za-z0-9+/=]+( .*)?)$'; then
    die "$f has a line that is not an age1… or ssh-ed25519 public key"
  fi
  n=$(grep -cE '^(age1|ssh-ed25519 )' "$f")
  [ "$n" -ge 1 ] || die "$f has no recipients"
}

# ---------------------------------------------------------------- targets

# parse_target <uri> → sets TARGET_KIND (s3|file), TARGET_BUCKET, TARGET_ROOT, TARGET_PREFIX
parse_target() {
  local uri=$1 rest
  case $uri in
    s3://*)
      TARGET_KIND=s3
      rest=${uri#s3://}
      TARGET_BUCKET=${rest%%/*}
      if [ "$rest" = "$TARGET_BUCKET" ]; then TARGET_PREFIX=''; else TARGET_PREFIX=${rest#*/}; fi
      TARGET_ROOT=''
      printf '%s' "$TARGET_BUCKET" | grep -qE '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' || die "bad bucket in $uri"
      ;;
    file:///*)
      TARGET_KIND=file
      TARGET_ROOT=${uri#file://}
      TARGET_BUCKET=''
      TARGET_PREFIX=''
      ;;
    *) die "unsupported target $uri (use s3://bucket/prefix or file:///abs/path)" ;;
  esac
  TARGET_PREFIX=${TARGET_PREFIX%/}
}

# Non-AWS S3 endpoint (Garage on the host, docs/ops/backups.md "Garage target"): credentials come from a
# shared-credentials file instead of the instance role, and AWS-only request features are not used.
s3_env() {
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    export AWS_SHARED_CREDENTIALS_FILE="${BACKUP_S3_CREDENTIALS_FILE:?BACKUP_S3_CREDENTIALS_FILE is required with BACKUP_S3_ENDPOINT}"
    export AWS_PROFILE="${BACKUP_S3_PROFILE:-garage}"
    export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
    export AWS_EC2_METADATA_DISABLED=true
  fi
}

s3_args() {
  printf '%s\n' --region "${BACKUP_S3_REGION:?BACKUP_S3_REGION is required for s3:// targets}"
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then printf '%s\n' --endpoint-url "$BACKUP_S3_ENDPOINT"; fi
  if [ -n "${BACKUP_S3_EXPECTED_OWNER:-}" ]; then printf '%s\n' --expected-bucket-owner "$BACKUP_S3_EXPECTED_OWNER"; fi
}

# target_put <local file> <key> <content-type> — create-only.
target_put() {
  local src=$1 key=$2 ctype=$3 dst
  case $TARGET_KIND in
    s3)
      s3_env
      if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
        # Garage ignores If-None-Match (conditional writes unsupported): check first. Keys carry a UTC
        # stamp and are unique per run, so the race window is theoretical.
        # shellcheck disable=SC2046
        if aws s3api head-object $(s3_args) --bucket "$TARGET_BUCKET" --key "$key" --no-cli-pager >/dev/null 2>&1; then
          die "refusing to overwrite s3://$TARGET_BUCKET/$key (create-only target)"
        fi
        # shellcheck disable=SC2046
        aws s3api put-object $(s3_args) --bucket "$TARGET_BUCKET" --key "$key" --body "$src" \
          --content-type "$ctype" --no-cli-pager --output text --query 'ETag' >/dev/null
      else
        # shellcheck disable=SC2046
        aws s3api put-object $(s3_args) --bucket "$TARGET_BUCKET" --key "$key" --body "$src" \
          --content-type "$ctype" --checksum-algorithm SHA256 --if-none-match '*' --no-cli-pager \
          --output text --query 'ETag' >/dev/null
      fi
      ;;
    file)
      dst="$TARGET_ROOT/$key"
      [ ! -e "$dst" ] || die "refusing to overwrite $dst (create-only target)"
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst.partial.$$"
      mv "$dst.partial.$$" "$dst"
      chmod 0440 "$dst"
      ;;
  esac
}

# target_get <key> <local file>
target_get() {
  local key=$1 dst=$2
  case $TARGET_KIND in
    s3)
      s3_env
      # shellcheck disable=SC2046
      aws s3api get-object $(s3_args) --bucket "$TARGET_BUCKET" --key "$key" --no-cli-pager "$dst" >/dev/null
      ;;
    file) cp "$TARGET_ROOT/$key" "$dst" ;;
  esac
}

# target_list <key prefix> → one key per line, sorted
target_list() {
  local p=$1
  case $TARGET_KIND in
    s3)
      s3_env
      # shellcheck disable=SC2046
      aws s3api list-objects-v2 $(s3_args) --bucket "$TARGET_BUCKET" --prefix "$p" --no-cli-pager \
        --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -v '^None$' | LC_ALL=C sort || true
      ;;
    file)
      if [ -d "$TARGET_ROOT/$p" ]; then
        (cd "$TARGET_ROOT" && find "$p" -type f ! -name '*.partial.*' | LC_ALL=C sort)
      fi
      ;;
  esac
}

# Object key layout: <prefix>/<tier>/<env>/<kind>/<YYYY>/<MM>/<DD>/<stamp>.<ext>
# Tier first so S3 lifecycle rules can expire `frequent/` and `daily/` independently of the environment.
object_key() {
  local tier=$1 env=$2 kind=$3 stamp=$4 ext=$5 day
  day="${stamp:0:4}/${stamp:4:2}/${stamp:6:2}"
  if [ -n "$TARGET_PREFIX" ]; then
    printf '%s/%s/%s/%s/%s/%s.%s' "$TARGET_PREFIX" "$tier" "$env" "$kind" "$day" "$stamp" "$ext"
  else
    printf '%s/%s/%s/%s/%s.%s' "$tier" "$env" "$kind" "$day" "$stamp" "$ext"
  fi
}

# Reads one string/number field of a manifest written by write_manifest (flat JSON, one key per line).
manifest_field() {
  sed -nE "s/^  \"$2\": \"?([^\",]*)\"?,?\$/\\1/p" "$1" | head -n 1
}
