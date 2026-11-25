#!/bin/sh
# Persistent Linux worker in Docker, paired to the local dev console (docs/ops/local-fleet-test.md §B).
#   sh scripts/dev/docker-worker.sh setup   # once: dev CA, image, config, volume
#   sh scripts/dev/docker-worker.sh proxy   # keep running: TLS proxy 127.0.0.1:8443 -> master 127.0.0.1:8080
#   sh scripts/dev/docker-worker.sh pair    # prints pairing code + fingerprint; approve in Fleet
#   sh scripts/dev/docker-worker.sh start   # run the paired worker in the background
#   sh scripts/dev/docker-worker.sh logs | stop | remove
set -eu
cd "$(dirname "$0")/../.."
ROOT=$PWD
TLS=infra/dev/secrets/fleet-tls
CONF_DIR="$HOME/.remyral-docker-worker"
NAME=remyral-worker-linux
VOLUME=remyral-worker-linux-data
IMAGE=remyral-worker-dev

mounts() {
  echo "-v $VOLUME:/var/lib/remyral-worker -v $CONF_DIR/config.json:/etc/remyral-worker/config.json:ro -v $ROOT/$TLS/ca.pem:/etc/remyral-worker/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem"
}

case "${1:-}" in
  setup)
    [ -f "$TLS/ca.pem" ] || node scripts/e2e/dev-ca.mjs "$TLS"
    pnpm --filter @remyral/worker bundle
    docker build -f infra/dev/docker-worker/Dockerfile --build-context bundle=apps/worker/dist -t "$IMAGE" infra/dev/docker-worker
    mkdir -p "$CONF_DIR"
    if [ ! -f "$CONF_DIR/config.json" ]; then
      printf '{\n  "masterUrl": "wss://host.docker.internal:8443",\n  "workspaceRoot": "/srv/remyral/workspaces",\n  "dataDir": "/var/lib/remyral-worker"\n}\n' >"$CONF_DIR/config.json"
      chmod 600 "$CONF_DIR/config.json"
    fi
    docker volume create "$VOLUME" >/dev/null
    echo "setup done. Next: 'proxy' in its own terminal, then 'pair'."
    ;;
  proxy)
    exec node scripts/e2e/tls-proxy.mjs --cert "$TLS/server.pem" --key "$TLS/server.key" \
      --listen 127.0.0.1:8443 --target 127.0.0.1:8080
    ;;
  pair)
    # shellcheck disable=SC2046
    docker run --rm -it $(mounts) "$IMAGE" pair
    ;;
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # shellcheck disable=SC2046
    docker run -d --name "$NAME" --restart unless-stopped $(mounts) "$IMAGE" run
    echo "started $NAME — Fleet should show it online in a few seconds ('logs' to follow)."
    ;;
  logs) exec docker logs -f "$NAME" ;;
  stop) docker stop "$NAME" ;;
  remove)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME"
    echo "removed. Revoke the worker in Fleet if you have not already."
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 2
    ;;
esac
