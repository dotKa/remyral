#!/usr/bin/env bash
# Control-plane host monitoring (p1-monitoring). Idempotent; run on the EC2 host as the sudo user from a
# copy of this directory (docs/ops/monitoring.md §3):
#
#   rsync -a infra/monitoring/ <host>:/tmp/remana-monitoring/
#   ssh <host> 'sudo bash /tmp/remana-monitoring/install-host.sh [--dry-run] [--env prod]'
#
# What it does:
#   1. Installs the Amazon CloudWatch agent .deb after verifying its GPG signature against the AWS key
#      fingerprint 9376 16F3 450B 7D80 6CBD 9725 D581 6730 3B78 9C72 (refuses to install otherwise).
#   2. Installs cloudwatch-agent.json (host CPU/memory/swap/disk metrics + the EMF listener on
#      127.0.0.1:25888) and (re)starts the agent with it. The instance role already carries
#      CloudWatchAgentServerPolicy; no keys are written anywhere.
#   3. Installs container-stats.sh + remana-container-stats.{service,timer} (per-container Up/Healthy/
#      CPU/memory once a minute as EMF) and enables the timer.
#   4. Sends one stats sample and prints it (--dry-run: prints every action instead of doing it).
#
# Prerequisite: the CloudFormation stack from infra/monitoring/cloudformation.json (log groups) exists,
# otherwise the agent cannot write the EMF log group. It does not touch Docker, Coolify or the stack.
set -euo pipefail

DRY=0
ENV_NAME=prod
CWAGENT_VERSION="${CWAGENT_VERSION:-latest}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --env)
      shift
      ENV_NAME="${1:-}"
      ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ENV_NAME" in
  *[!a-z0-9-]* | '') echo "invalid --env" >&2; exit 2 ;;
esac
case "$CWAGENT_VERSION" in
  *[!A-Za-z0-9.]* | '') echo "invalid CWAGENT_VERSION" >&2; exit 2 ;;
esac
run() { echo "+ $*"; if [ "$DRY" = 0 ]; then "$@"; fi; }
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in cloudwatch-agent.json container-stats.sh remana-container-stats.service remana-container-stats.timer; do
  [ -f "$HERE/$f" ] || { echo "missing $HERE/$f" >&2; exit 1; }
done

ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
case "$ARCH" in amd64 | arm64) ;; *) echo "unsupported architecture $ARCH" >&2; exit 1 ;; esac
BASE="https://amazoncloudwatch-agent.s3.amazonaws.com"
FPR="937616F3450B7D806CBD9725D58167303B789C72"
CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
CONF=/opt/aws/amazon-cloudwatch-agent/etc/remana-cloudwatch-agent.json

echo "== 1. CloudWatch agent (${CWAGENT_VERSION}, ${ARCH})"
if [ -x "$CTL" ] && [ "${REINSTALL_AGENT:-0}" != 1 ]; then
  echo "already installed ($("$CTL" -a status 2>/dev/null | grep -o '"version": *"[^"]*"' || echo 'version unknown')); REINSTALL_AGENT=1 to upgrade"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  run curl -fsSL --proto '=https' -o "$WORK/agent.deb" "$BASE/ubuntu/$ARCH/$CWAGENT_VERSION/amazon-cloudwatch-agent.deb"
  run curl -fsSL --proto '=https' -o "$WORK/agent.deb.sig" "$BASE/ubuntu/$ARCH/$CWAGENT_VERSION/amazon-cloudwatch-agent.deb.sig"
  run curl -fsSL --proto '=https' -o "$WORK/agent.gpg" "$BASE/assets/amazon-cloudwatch-agent.gpg"
  if [ "$DRY" = 0 ]; then
    export GNUPGHOME="$WORK/gnupg"
    install -d -m 700 "$GNUPGHOME"
    gpg --batch --quiet --import "$WORK/agent.gpg"
    got="$(gpg --batch --with-colons --fingerprint | awk -F: '/^fpr:/ {print $10; exit}')"
    [ "$got" = "$FPR" ] || { echo "CloudWatch agent key fingerprint mismatch ($got); not installing" >&2; exit 1; }
    gpg --batch --status-fd 1 --verify "$WORK/agent.deb.sig" "$WORK/agent.deb" 2>/dev/null \
      | grep -q "^\[GNUPG:\] VALIDSIG $FPR" || { echo "CloudWatch agent signature invalid; not installing" >&2; exit 1; }
    echo "signature ok ($FPR)"
  fi
  run dpkg -i -E "$WORK/agent.deb"
fi

echo "== 2. agent configuration"
run install -m 0644 -o root -g root "$HERE/cloudwatch-agent.json" "$CONF"
run "$CTL" -a fetch-config -m ec2 -s -c "file:$CONF"

echo "== 3. container stats timer"
run install -d -m 0755 /usr/local/lib/remana /etc/remana
run install -m 0755 -o root -g root "$HERE/container-stats.sh" /usr/local/lib/remana/container-stats.sh
run install -m 0644 -o root -g root "$HERE/remana-container-stats.service" /etc/systemd/system/remana-container-stats.service
run install -m 0644 -o root -g root "$HERE/remana-container-stats.timer" /etc/systemd/system/remana-container-stats.timer
if [ "$DRY" = 0 ]; then
  umask 022
  printf 'REMANA_ENV=%s\n' "$ENV_NAME" >/etc/remana/monitoring.env
else
  echo "+ write /etc/remana/monitoring.env (REMANA_ENV=$ENV_NAME)"
fi
run systemctl daemon-reload
run systemctl enable --now remana-container-stats.timer

echo "== 4. one sample"
if [ "$DRY" = 0 ]; then
  REMANA_ENV="$ENV_NAME" /usr/local/lib/remana/container-stats.sh --dry-run
  run systemctl start remana-container-stats.service
  "$CTL" -a status
fi
echo "done: metrics appear in CloudWatch (Remana/Host, Remana/Containers) within ~2 minutes."
