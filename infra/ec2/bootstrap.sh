#!/usr/bin/env bash
# Control-plane host bootstrap (p1-iac / p1-coolify). Idempotent; run as the default sudo user:
#   scp infra/ec2/bootstrap.sh ubuntu@HOST: && ssh ubuntu@HOST 'sudo bash bootstrap.sh [--dry-run] [--no-coolify]'
# What it does (docs/ops/deploy-coolify.md):
#   1. OS updates + unattended security upgrades, UTC, chrony
#   2. 2 GiB swap (t3.medium has 4 GiB RAM; Coolify + Postgres + Redis + master)
#   3. sshd hardening: keys only, no root login, no forwarding except local (Coolify UI tunnel)
#   4. ufw: deny incoming except 22, 80, 443 (defence in depth — the AWS security group is the real
#      perimeter: Docker-published ports bypass ufw, so 8000/6001/6002 MUST stay closed in the SG)
#   5. Coolify via its official install script, downloaded, checksummed and logged before running
set -euo pipefail

DRY=0
COOLIFY=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-coolify) COOLIFY=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else echo "+ $*"; "$@"; fi; }
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1. updates"
run apt-get update -q
run apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
run apt-get -y -q install unattended-upgrades chrony ufw curl ca-certificates jq
run timedatectl set-timezone UTC
if [ "$DRY" = 0 ]; then
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
fi

echo "== 2. swap"
if ! swapon --show | grep -q /swapfile; then
  run fallocate -l 2G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  [ "$DRY" = 1 ] || grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  [ "$DRY" = 1 ] || echo 'vm.swappiness=10' >/etc/sysctl.d/90-swappiness.conf
fi

echo "== 3. sshd"
if [ "$DRY" = 0 ]; then
  cat >/etc/ssh/sshd_config.d/90-remyral.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
AllowAgentForwarding no
X11Forwarding no
AllowTcpForwarding local
PermitTunnel no
MaxAuthTries 3
LoginGraceTime 30
EOF
  sshd -t
  # Ubuntu 24.04+ uses socket activation (ssh.socket): sshd reads the config per connection, so only
  # reload when a long-running ssh.service exists.
  if systemctl is-active --quiet ssh.service; then systemctl reload ssh.service; fi
else
  echo "+ write /etc/ssh/sshd_config.d/90-remyral.conf (keys only, no root password, local forwarding only)"
fi
# Coolify manages this server over SSH as root via its own key (localhost). prohibit-password keeps that
# key-only; nothing else logs in as root.

echo "== 4. ufw"
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow 22/tcp
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable

if [ "$COOLIFY" = 1 ]; then
  echo "== 5. coolify"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^coolify$'; then
    echo "coolify already running — skipping install (upgrade from its UI)"
  else
    tmp=$(mktemp)
    run curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o "$tmp"
    if [ "$DRY" = 0 ]; then
      sum=$(sha256sum "$tmp" | cut -d' ' -f1)
      mkdir -p /var/log/remyral
      cp "$tmp" "/var/log/remyral/coolify-install-$sum.sh"
      echo "coolify install.sh sha256=$sum (kept in /var/log/remyral for audit)"
      bash "$tmp"
    fi
  fi
fi

echo "== done"
swapon --show || true
ufw status verbose | head -12 || true
