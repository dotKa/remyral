#!/usr/bin/env bash
# Runs INSIDE the systemd test container (see systemd-e2e.sh). Exercises the real installer,
# the real unit under real systemd, crash/restart, graceful stop, exit-78 handling, hardening,
# idempotency and uninstall. Prints PASS/FAIL lines; exits non-zero on the first failure.
set -euo pipefail

SRC=/src            # infra/worker/linux (read-only)
BUNDLE=/bundle/remyral-worker.mjs
UNIT=remyral-worker.service
pass=0

ok() { pass=$((pass + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; journalctl -u $UNIT --no-pager -n 40 >&2 || true; exit 1; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
prop() { systemctl show -p "$1" --value $UNIT; }
wait_for() { # wait_for SECONDS DESCRIPTION CMD...
  local t=$1 what=$2; shift 2
  for _ in $(seq 1 $((t * 5))); do if "$@"; then ok "$what"; return 0; fi; sleep 0.2; done
  fail "$what (timeout ${t}s)"
}
mode_of() { stat -c '%a %U %G' "$1"; }
is_active() { [ "$(systemctl is-active $UNIT)" = active ]; }
pid_changed() { local p; p=$(prop MainPID); [ "$p" != 0 ] && [ "$p" != "$1" ]; }

# Wait for systemd to finish booting the container.
for _ in $(seq 1 100); do
  s=$(systemctl is-system-running 2>/dev/null || true)
  case $s in running | degraded) break ;; esac
  sleep 0.2
done
echo "systemd $(systemctl --version | head -1 | cut -d' ' -f2), system state: $s, arch $(uname -m)"

# --- 1. unit verifies ------------------------------------------------------------------------
sed "s#@NODE@#/usr/local/bin/node#" $SRC/remyral-worker.service >/tmp/$UNIT
useradd --system --no-create-home --shell /usr/sbin/nologin verifytmp 2>/dev/null || true
sed -i 's/^User=.*/User=verifytmp/; s/^Group=.*/Group=verifytmp/' /tmp/$UNIT
out=$(systemd-analyze verify --man=no /tmp/$UNIT 2>&1 || true)
check "systemd-analyze verify: no findings ($out)" [ -z "$out" ]
userdel verifytmp

# --- 2. dry-run as an unprivileged user changes nothing ----------------------------------------
out=$(su -s /bin/bash node -c "bash $SRC/install.sh --dry-run --bundle $BUNDLE --master-url wss://m.example.com/v1/worker")
echo "$out" | sed 's/^/    | /'
check "dry-run prints the useradd action" grep -q '^\[dry-run\] useradd --system --user-group' <<<"$out"
check "dry-run prints the unit install" grep -q "^\[dry-run\] install -o root -g root -m 0644 .* /etc/systemd/system/$UNIT" <<<"$out"
check "dry-run prints systemctl enable/start" grep -q '^\[dry-run\] systemctl start' <<<"$out"
check "dry-run shows the rendered unit" grep -q '^\[dry-run\]   | ProtectSystem=strict' <<<"$out"
check "dry-run created no user" bash -c '! getent passwd remyral-worker'
check "dry-run created no files" bash -c '[ ! -e /opt/remyral-worker ] && [ ! -e /etc/remyral-worker ] && [ ! -e /etc/systemd/system/remyral-worker.service ]'

# --- 3. install without config: installed + enabled, not started -------------------------------
bash $SRC/install.sh --bundle $BUNDLE >/tmp/i1.log 2>&1 || { cat /tmp/i1.log; fail "install without config"; }
check "enabled after install" [ "$(systemctl is-enabled $UNIT)" = enabled ]
check "not started without config" [ "$(systemctl is-active $UNIT)" != active ]
check "backoff drop-in installed (systemd >= 254) or skipped" bash -c "[ \$(systemctl --version | head -1 | cut -d' ' -f2) -lt 254 ] || [ -f /etc/systemd/system/$UNIT.d/10-restart-backoff.conf ]"

# --- 4. install with master URL: config written, service runs -----------------------------------
bash $SRC/install.sh --bundle $BUNDLE --master-url wss://m.example.com/v1/worker >/tmp/i2.log 2>&1 || { cat /tmp/i2.log; fail "install with config"; }
wait_for 15 "service active" is_active
IFS=: read -r _ _ uid _ _ home shell <<<"$(getent passwd remyral-worker)"
check "system user (uid $uid < 1000)" [ "$uid" -lt 1000 ]
check "no login shell ($shell)" bash -c "case $shell in */nologin|*/false) true;; *) false;; esac"
check "home $home" [ "$home" = /var/lib/remyral-worker/home ]
check "password locked" bash -c "passwd -S remyral-worker | awk '{print \$2}' | grep -qE '^(L|LK)$'"
check "/opt/remyral-worker 755 root" [ "$(mode_of /opt/remyral-worker)" = "755 root root" ]
check "bundle 644 root" [ "$(mode_of /opt/remyral-worker/remyral-worker.mjs)" = "644 root root" ]
check "/etc/remyral-worker 750 root:remyral-worker" [ "$(mode_of /etc/remyral-worker)" = "750 root remyral-worker" ]
check "config 640 root:remyral-worker" [ "$(mode_of /etc/remyral-worker/config.json)" = "640 root remyral-worker" ]
check "data dir 700 remyral-worker" [ "$(mode_of /var/lib/remyral-worker)" = "700 remyral-worker remyral-worker" ]
check "workspaces 700 remyral-worker" [ "$(mode_of /var/lib/remyral-worker/workspaces)" = "700 remyral-worker remyral-worker" ]
wait_for 10 "device key created 600 by the service user" bash -c '[ "$(stat -c "%a %U" /var/lib/remyral-worker/device-key.json 2>/dev/null)" = "600 remyral-worker" ]'
check "unit file 644 root" [ "$(mode_of /etc/systemd/system/$UNIT)" = "644 root root" ]
check "main process runs as remyral-worker" [ "$(ps -o user= -p "$(prop MainPID)")" = remyral-worker ]
wait_for 10 "journald has the JSON startup log" bash -c "journalctl -u $UNIT --no-pager -o cat | grep -q '\"msg\":\"worker daemon starting\"'"
check "pairing code + fingerprint logged for the owner" bash -c "journalctl -u $UNIT --no-pager -o cat | grep -q '\"pairingCode\":\"[A-Z2-9]\{4\}-[A-Z2-9]\{4\}\"'"

# --- 5. hardening as seen from inside the service's mount namespace ------------------------------
pid=$(prop MainPID)
ns() { nsenter -t "$pid" -m -S "$uid" -G "$uid" -- "$@"; }
nsroot() { nsenter -t "$pid" -m -- "$@"; }
check "interactive user's ~/.ssh invisible (ProtectHome)" bash -c "! nsenter -t $pid -m -S $uid -G $uid -- cat /home/node/.ssh/id_canary 2>/dev/null"
check "/usr is read-only even for root in the unit's namespace (ProtectSystem=strict)" bash -c "! nsenter -t $pid -m -- touch /usr/remyral-probe 2>/dev/null"
check "/opt bundle is read-only" bash -c "! nsenter -t $pid -m -- touch /opt/remyral-worker/x 2>/dev/null"
check "data dir is writable for the service user" ns touch /var/lib/remyral-worker/workspaces/.probe
ns rm -f /var/lib/remyral-worker/workspaces/.probe
check "config not writable by the service user" bash -c "! nsenter -t $pid -m -S $uid -G $uid -- sh -c 'echo x >> /etc/remyral-worker/config.json' 2>/dev/null"
check "no capabilities (CapEff=0)" bash -c "grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/$pid/status"
check "NoNewPrivileges set" bash -c "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/$pid/status"
exposure=$(systemd-analyze security --no-pager $UNIT 2>/dev/null | tail -1 || true)
echo "    systemd-analyze security: $exposure"

# --- 6. `remyral-worker service status` -----------------------------------------------------------
st=$(remyral-worker service status) && rc=0 || rc=$?
echo "$st" | sed 's/^/    | /'
check "service status exits 0 while running" [ "$rc" = 0 ]
check "service status shows the live daemon" grep -q 'Worker:   offline, 0 running job(s)' <<<"$st"

# --- 7. crash → restart (A-FLEET-4) --------------------------------------------------------------
before=$(prop NRestarts)
kill -SEGV "$pid"
wait_for 20 "restarted after SIGSEGV (new pid)" pid_changed "$pid"
check "NRestarts incremented" [ "$(prop NRestarts)" -gt "$before" ]
pid2=$(prop MainPID)
kill -KILL "$pid2"
wait_for 20 "restarted after SIGKILL" pid_changed "$pid2"
wait_for 10 "status file rewritten by the new daemon" bash -c "remyral-worker service status | grep -q 'Worker:   offline'"
check "same device key after restarts (no re-pairing)" bash -c "[ \$(journalctl -u $UNIT --no-pager -o cat | grep -o '\"fingerprint\":\"[^\"]*\"' | sort -u | wc -l) = 1 ]"

# --- 8. graceful stop → exit 0, no restart -------------------------------------------------------
systemctl stop $UNIT
check "stopped" [ "$(systemctl is-active $UNIT)" = inactive ]
check "clean exit status 0" [ "$(prop ExecMainStatus)" = 0 ]
check "Result=success" [ "$(prop Result)" = success ]
sleep 7
check "not restarted after a clean stop" [ "$(systemctl is-active $UNIT)" = inactive ]
st=$(remyral-worker service status) && rc=0 || rc=$?
check "service status exits 3 when stopped" [ "$rc" = 3 ]
check "service status reports the graceful stop" grep -q 'stopped gracefully' <<<"$st"

# --- 9. config error → exit 78, no restart loop ----------------------------------------------------
cp /etc/remyral-worker/config.json /tmp/config.good
echo '{"masterUrl":"ws://evil.example/v1","workspaceRoot":"/var/lib/remyral-worker/workspaces"}' >/etc/remyral-worker/config.json
systemctl start $UNIT || true
wait_for 15 "exit 78 → failed" bash -c "[ \"\$(systemctl is-active $UNIT)\" = failed ]"
check "ExecMainStatus=78" [ "$(prop ExecMainStatus)" = 78 ]
n=$(prop NRestarts)
sleep 7
check "no restart loop on exit 78" [ "$(prop NRestarts)" = "$n" ]
check "journal explains the config problem" bash -c "journalctl -u $UNIT --no-pager -o cat | grep -q 'plain ws:// is only allowed'"
install -o root -g remyral-worker -m 0640 /tmp/config.good /etc/remyral-worker/config.json
systemctl reset-failed $UNIT
systemctl start $UNIT
wait_for 15 "back to active with the good config" is_active

# --- 10. idempotency ---------------------------------------------------------------------------------
out=$(bash $SRC/install.sh --bundle $BUNDLE --master-url wss://m.example.com/v1/worker 2>&1)
check "re-run performs no actions" bash -c "! grep -q '^+ ' <<<'$out'"
check "re-run keeps the service running" is_active
check "re-run warns that the existing config was not changed" grep -q 'config exists and was NOT changed' <<<"$out"

# --- 11. uninstall (keep data) / purge -----------------------------------------------------------------
bash $SRC/uninstall.sh --dry-run >/tmp/u0.log
check "uninstall dry-run leaves the service running" is_active
bash $SRC/uninstall.sh >/tmp/u1.log 2>&1 || { cat /tmp/u1.log; fail "uninstall"; }
check "unit removed" [ ! -e /etc/systemd/system/$UNIT ]
check "bundle removed" [ ! -e /opt/remyral-worker ]
check "data + key kept" [ -f /var/lib/remyral-worker/device-key.json ]
check "user kept" getent passwd remyral-worker
bash $SRC/uninstall.sh >/tmp/u2.log 2>&1 || { cat /tmp/u2.log; fail "second uninstall"; }
ok "uninstall is idempotent"
bash $SRC/install.sh --bundle $BUNDLE >/tmp/i3.log 2>&1 || { cat /tmp/i3.log; fail "reinstall"; }
wait_for 15 "reinstall reuses kept config/key and runs" is_active
bash $SRC/uninstall.sh --purge >/tmp/u3.log 2>&1 || { cat /tmp/u3.log; fail "purge"; }
check "purge removed config, data and user" bash -c '[ ! -e /etc/remyral-worker ] && [ ! -e /var/lib/remyral-worker ] && ! getent passwd remyral-worker && ! getent group remyral-worker'
bash $SRC/uninstall.sh --purge >/tmp/u4.log 2>&1 || { cat /tmp/u4.log; fail "second purge"; }
ok "purge is idempotent"

echo "ALL PASSED ($pass checks)"
