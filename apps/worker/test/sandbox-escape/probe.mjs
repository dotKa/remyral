/* global setTimeout, clearTimeout, setInterval, Buffer */
// Sandbox escape probes (p3-sandbox, p7-sandbox-escape). Runs *inside* a sandbox
// (container or host profile) with node only, no dependencies. Every probe tries
// something the sandbox must prevent and prints one JSON line:
//   {"probe": "<id>", "target": "...", "outcome": "denied" | "allowed", "detail": "..."}
// The test decides what each profile must deny. Only fake secrets are ever targeted.
//
// Usage: node probe.mjs '<json config>'   (config: see `cfg` fields below)
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const cfg = JSON.parse(process.argv[2] ?? '{}');
const results = [];
const emit = (probe, target, outcome, detail = '') => {
  const r = { probe, target, outcome, detail: String(detail).slice(0, 200) };
  results.push(r);
  process.stdout.write(`${JSON.stringify(r)}\n`);
};
const code = (e) => (e && typeof e === 'object' && 'code' in e ? e.code : String(e));

function tcp(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, detail: 'timeout' });
    }, ms);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve({ ok: true, detail: 'connected' });
    });
    s.once('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, detail: code(e) });
    });
  });
}

/** CONNECT host:port through an HTTP proxy URL; resolves with the status code (0 = no answer). */
function viaProxy(proxyUrl, target, ms = 8000) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const s = connect({ host: u.hostname, port: Number(u.port) });
    let buf = '';
    const t = setTimeout(() => {
      s.destroy();
      resolve({ status: 0, detail: 'timeout' });
    }, ms);
    s.once('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(t);
        s.destroy();
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), detail: buf.split('\r\n')[0] });
      }
    });
    s.once('error', (e) => {
      clearTimeout(t);
      resolve({ status: 0, detail: code(e) });
    });
  });
}

// 1. Writes outside the workspace.
for (const p of cfg.writeOutside ?? []) {
  try {
    writeFileSync(p, 'escape');
    emit('write-outside-workspace', p, 'allowed');
    try {
      rmSync(p);
    } catch {
      /* ignore */
    }
  } catch (e) {
    emit('write-outside-workspace', p, 'denied', code(e));
  }
}
// Control: the workspace itself is writable.
if (cfg.writeInside) {
  try {
    writeFileSync(cfg.writeInside, 'ok');
    emit('write-inside-workspace', cfg.writeInside, 'allowed');
  } catch (e) {
    emit('write-inside-workspace', cfg.writeInside, 'denied', code(e));
  }
}

// 2. Reads of secrets: ~/.ssh, keychains, browser profiles, the worker's key file, other attempts.
for (const p of cfg.readSecrets ?? []) {
  try {
    readFileSync(p);
    emit('read-secret', p, 'allowed');
  } catch (e) {
    emit('read-secret', p, 'denied', code(e));
  }
}
for (const p of cfg.listDirs ?? []) {
  try {
    readdirSync(p);
    emit('list-dir', p, 'allowed');
  } catch (e) {
    emit('list-dir', p, 'denied', code(e));
  }
}

// 3. Network: cloud metadata, private LAN, the internet directly.
for (const [probe, host, port] of [
  ['metadata-ip', '169.254.169.254', 80],
  ['private-lan-ip', cfg.lanIp ?? '192.168.1.1', cfg.lanPort ?? 80],
  ['direct-internet', cfg.internetIp ?? '1.1.1.1', 443],
]) {
  const r = await tcp(host, port);
  emit(probe, `${host}:${String(port)}`, r.ok ? 'allowed' : 'denied', r.detail);
}

// 4. Egress proxy: allowlisted vs not allowlisted host.
const proxyUrl = cfg.proxy === 'env' ? process.env.HTTPS_PROXY : cfg.proxy;
if (proxyUrl) {
  for (const t of cfg.proxyAllowed ?? []) {
    const r = await viaProxy(proxyUrl, t);
    emit('proxy-allowlisted', t, r.status === 200 ? 'allowed' : 'denied', r.detail);
  }
  for (const t of cfg.proxyDenied ?? []) {
    const r = await viaProxy(proxyUrl, t);
    emit('proxy-not-allowlisted', t, r.status === 200 ? 'allowed' : 'denied', r.detail);
  }
}

// 5. Listening port on all interfaces (reachability from outside is checked by the test).
if (cfg.listenPort !== undefined) {
  await new Promise((resolve) => {
    const srv = createServer((s) => s.end('hello-from-sandbox\n'));
    srv.once('error', (e) => {
      emit('listen-any-interface', `0.0.0.0:${String(cfg.listenPort)}`, 'denied', code(e));
      resolve();
    });
    srv.listen(cfg.listenPort, '0.0.0.0', () => {
      emit('listen-any-interface', `0.0.0.0:${String(srv.address().port)}`, 'allowed', 'bound');
      if (cfg.keepListening) process.stdout.write(`${JSON.stringify({ listening: srv.address().port })}\n`);
      else srv.close();
      resolve();
    });
  });
}

// 6. Engine socket.
for (const p of ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']) {
  try {
    readdirSync(p);
    emit('engine-socket', p, 'allowed');
  } catch (e) {
    emit('engine-socket', p, code(e) === 'ENOTDIR' ? 'allowed' : 'denied', code(e));
  }
}

// 7. A detached background process meant to survive cancellation; its pid goes to a file.
if (cfg.backgroundPidFile) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(cfg.backgroundPidFile, String(child.pid));
  emit('background-process', String(child.pid), 'allowed', 'spawned detached (survival checked by the test)');
}

// 8. Fork bomb (bounded by the pids limit): count children until spawn fails.
if (cfg.forkBomb) {
  let n = 0;
  let err = '';
  const kids = [];
  for (; n < cfg.forkBomb; n++) {
    try {
      const k = spawn('sleep', ['30'], { stdio: 'ignore' });
      const failed = await new Promise((resolve) => {
        k.once('spawn', () => resolve(false));
        k.once('error', (e) => {
          err = code(e);
          resolve(true);
        });
      });
      if (failed) break;
      kids.push(k);
    } catch (e) {
      err = code(e);
      break;
    }
  }
  emit('fork-bomb', `spawned ${String(n)}`, n >= cfg.forkBomb ? 'allowed' : 'denied', err);
  for (const k of kids) k.kill('SIGKILL');
}

// 9. Memory hog: allocate until killed (the process should be OOM-killed by the cgroup).
if (cfg.memoryHogMiB) {
  const hold = [];
  for (let i = 0; i < cfg.memoryHogMiB; i++) {
    hold.push(Buffer.alloc(1024 * 1024, 1));
  }
  emit('memory-hog', `${String(cfg.memoryHogMiB)} MiB`, 'allowed', 'not killed');
}

if (cfg.hang) {
  process.stdout.write(`${JSON.stringify({ hanging: true })}\n`);
  setInterval(() => undefined, 60_000);
  await new Promise(() => undefined);
}
process.stdout.write(`${JSON.stringify({ done: true, count: results.length })}\n`);
