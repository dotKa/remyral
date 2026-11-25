#!/usr/bin/env bash
# One-off Garage setup on the control-plane host (idempotent). Run as root from the source tree:
#   sudo infra/garage/setup.sh
# Creates /data/remyral/garage/garage.toml (random rpc/admin secrets), starts the container, assigns the
# single-node layout, creates bucket `remyral-backups` and key `remyral-backup` with read+write on it, and
# writes the key to /etc/remyral/backup/garage-credentials (AWS shared-credentials format, root 0600).
# Secrets are never printed.
set -Eeuo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
D=/data/remyral/garage
BUCKET=${GARAGE_BUCKET:-remyral-backups}
KEY=${GARAGE_KEY:-remyral-backup}
CRED=/etc/remyral/backup/garage-credentials
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

install -d -m 0700 "$D" /etc/remyral/backup
if [ ! -f "$D/garage.toml" ]; then
  cat >"$D/garage.toml" <<TOML
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"
metadata_auto_snapshot_interval = "6h"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$(openssl rand -hex 32)"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "$(openssl rand -base64 32)"
TOML
  chmod 0600 "$D/garage.toml" # root-only; the container runs as root and reads it via a read-only bind mount
fi

docker compose -p remyral-garage -f "$HERE/compose.yaml" up -d
g() { docker exec remyral-garage-garage-1 /garage "$@"; }
for i in $(seq 1 30); do g status >/dev/null 2>&1 && break; sleep 1; done

if g layout show 2>/dev/null | grep -q 'No nodes currently have a role'; then
  node=$(g node id -q | cut -d@ -f1)
  g layout assign -z dc1 -c 20G "$node" >/dev/null
  g layout apply --version 1 >/dev/null
fi
g bucket info "$BUCKET" >/dev/null 2>&1 || g bucket create "$BUCKET" >/dev/null
if ! g key info "$KEY" >/dev/null 2>&1; then
  out=$(g key create "$KEY")
  id=$(printf '%s\n' "$out" | awk '/Key ID:/ {print $3}')
  secret=$(printf '%s\n' "$out" | awk '/Secret key:/ {print $3}')
  [ -n "$id" ] && [ -n "$secret" ] || { echo "could not parse key create output" >&2; exit 1; }
  printf '[garage]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$secret" >"$CRED"
  chmod 0600 "$CRED"
fi
g bucket allow "$BUCKET" --read --write --key "$KEY" >/dev/null
echo "garage ready: bucket=$BUCKET key=$KEY credentials=$CRED (not printed)"
docker image inspect "$(docker inspect -f '{{.Image}}' remyral-garage-garage-1)" -f 'image digest: {{index .RepoDigests 0}}'
