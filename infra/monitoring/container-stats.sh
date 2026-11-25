#!/usr/bin/env bash
# Remana container stats → CloudWatch metrics (p1-monitoring, docs/ops/monitoring.md).
#
# Runs once a minute from remana-container-stats.timer (root: it needs the Docker socket). For every
# expected compose service of the environment it emits one CloudWatch Embedded Metric Format (EMF) line to
# the local CloudWatch agent (UDP 127.0.0.1:25888, `logs.metrics_collected.emf` in cloudwatch-agent.json):
#
#   Namespace Remana/Containers, dimensions [Environment, Service]:
#     Up             1 if the container exists and is running, else 0 (a missing container reports 0)
#     Healthy        1 if running and its Docker healthcheck is "healthy" (or it has none), else 0
#     CpuPercent     docker stats CPU % (of one core; may exceed 100 on 2 vCPUs)
#     MemoryPercent  docker stats memory % of the container's mem_limit
#
# Only numbers, the environment and the service name leave the host — no container names, ids, labels,
# environment variables, command lines or log text. Bash 3.2 compatible (no associative arrays).
#
# Options / environment (all optional):
#   --dry-run                       print the EMF lines instead of sending them
#   REMANA_ENV=prod                 compose project is remana-$REMANA_ENV
#   REMANA_MONITORED_SERVICES="master web postgres redis"
#   REMANA_METRICS_LOG_GROUP=/remana/$REMANA_ENV/metrics   (created by cloudformation.json)
#   REMANA_EMF_TARGET=/dev/udp/127.0.0.1/25888             (a file path in tests)
#   DOCKER=docker
set -euo pipefail

ENV_NAME="${REMANA_ENV:-prod}"
case "$ENV_NAME" in
  *[!a-z0-9-]* | '') echo "container-stats: invalid REMANA_ENV" >&2; exit 64 ;;
esac
PROJECT="remana-${ENV_NAME}"
SERVICES="${REMANA_MONITORED_SERVICES:-master web postgres redis}"
LOG_GROUP="${REMANA_METRICS_LOG_GROUP:-/remana/${ENV_NAME}/metrics}"
case "$LOG_GROUP" in
  *[!A-Za-z0-9/_.-]* | '') echo "container-stats: invalid REMANA_METRICS_LOG_GROUP" >&2; exit 64 ;;
esac
EMF_TARGET="${REMANA_EMF_TARGET:-/dev/udp/127.0.0.1/25888}"
DOCKER="${DOCKER:-docker}"
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

# A decimal number or 0 (docker prints "--" for stopped containers).
num() {
  local v="${1%\%}"
  if printf '%s' "$v" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then printf '%s' "$v"; else printf '0'; fi
}

emit() {
  local service="$1" up="$2" healthy="$3" cpu="$4" mem="$5" ts
  ts="$(($(date +%s) * 1000))"
  local line
  line="{\"_aws\":{\"Timestamp\":${ts},\"LogGroupName\":\"${LOG_GROUP}\",\"CloudWatchMetrics\":[{\"Namespace\":\"Remana/Containers\",\"Dimensions\":[[\"Environment\",\"Service\"]],\"Metrics\":[{\"Name\":\"Up\",\"Unit\":\"Count\"},{\"Name\":\"Healthy\",\"Unit\":\"Count\"},{\"Name\":\"CpuPercent\",\"Unit\":\"Percent\"},{\"Name\":\"MemoryPercent\",\"Unit\":\"Percent\"}]}]},\"Environment\":\"${ENV_NAME}\",\"Service\":\"${service}\",\"Up\":${up},\"Healthy\":${healthy},\"CpuPercent\":${cpu},\"MemoryPercent\":${mem}}"
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "$line"
  else
    case "$EMF_TARGET" in
      /dev/udp/* | /dev/tcp/*) printf '%s\n' "$line" >"$EMF_TARGET" ;; # one datagram per event
      *) printf '%s\n' "$line" >>"$EMF_TARGET" ;;
    esac
  fi
}

for service in $SERVICES; do
  case "$service" in
    *[!a-z0-9-]* | '') echo "container-stats: invalid service name" >&2; exit 64 ;;
  esac
  id="$("$DOCKER" ps -a --no-trunc \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}' | head -n 1 || true)"
  if [ -z "$id" ]; then
    emit "$service" 0 0 0 0
    continue
  fi
  state="$("$DOCKER" inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo 'false unknown')"
  running="${state%% *}"
  health="${state#* }"
  up=0
  healthy=0
  cpu=0
  mem=0
  if [ "$running" = "true" ]; then
    up=1
    if [ "$health" = "healthy" ] || [ "$health" = "none" ]; then healthy=1; fi
    stats="$("$DOCKER" stats --no-stream --format '{{.CPUPerc}} {{.MemPerc}}' "$id" 2>/dev/null || echo '0 0')"
    cpu="$(num "${stats%% *}")"
    mem="$(num "${stats#* }")"
  fi
  emit "$service" "$up" "$healthy" "$cpu" "$mem"
done
