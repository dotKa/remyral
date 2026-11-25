#!/usr/bin/env node
// A fake `docker` for scripts/test/selfhost-ctl.test.mjs (p16-selfhost-onboarding): enough of the Docker CLI and the
// compose plugin for remyral-ctl's install / upgrade / rollback paths, with state in $FAKE_DOCKER_STATE (JSON) and
// every invocation appended to $FAKE_DOCKER_LOG. No container, image or network is ever touched.
//
// State knobs (set by the test before a run): users, dbHead, migrateTo{version→head}, unhealthy[image refs],
// failMigrate, failBackup, wrongDigest, failDrill, failUp[services] (p17-host-actions).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.FAKE_DOCKER_STATE;
const LOG = process.env.FAKE_DOCKER_LOG;
const args = process.argv.slice(2);
appendFileSync(LOG, `${args.join(' ')}\n`);

const load = () =>
  existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, 'utf8'))
    : { images: {}, containers: {}, networks: [], users: 0, dbHead: '', backups: [] };
const state = load();
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const print = (s) => process.stdout.write(`${s}\n`);
const exit = (code) => {
  save();
  process.exit(code);
};

const FIXED = {
  postgres: 'postgres:18.6-alpine@sha256:fixed',
  redis: 'redis:8.10.2-alpine@sha256:fixed',
  proxy: 'traefik:v3.7.14@sha256:fixed',
  migrate: 'migrate',
};
let seq = Object.keys(state.containers).length;
const idOf = () => `c${String((seq += 1)).padStart(11, '0')}`;
const byId = (id) => Object.entries(state.containers).find(([, c]) => c.id === id);

function envFiles(list) {
  const env = {};
  for (const f of list) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

function compose(rest) {
  const files = [];
  let projectDir = '';
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) {
    const flag = rest[i];
    if (flag === '--env-file') files.push(rest[i + 1]);
    if (flag === '--project-directory') projectDir = rest[i + 1];
    i += ['-p', '--project-directory', '--env-file', '-f', '--profile'].includes(flag) ? 2 : 1;
  }
  const sub = rest[i];
  const tail = rest.slice(i + 1);
  const env = envFiles(files);
  const imageFor = (svc) =>
    ({ master: env.REMYRAL_MASTER_IMAGE, web: env.REMYRAL_WEB_IMAGE, backup: env.REMYRAL_BACKUP_IMAGE })[
      svc
    ] ?? FIXED[svc];
  switch (sub) {
    case 'version':
      print('2.29.7');
      return exit(0);
    case 'pull':
      return exit(0);
    case 'up': {
      const services = tail.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
      if (services.some((svc) => (state.failUp ?? []).includes(svc))) return exit(1);
      for (const svc of services) {
        const image = imageFor(svc);
        const old = state.containers[svc];
        const health = (state.unhealthy ?? []).includes(image) ? 'unhealthy' : 'healthy';
        state.containers[svc] = {
          id: old && old.image === image ? old.id : idOf(),
          image,
          health,
          running: true,
        };
      }
      return exit(0);
    }
    case 'run': {
      if (tail.includes('migrate')) {
        if (state.failMigrate) return exit(1);
        const manifest = readFileSync(join(projectDir, 'manifest.json'), 'utf8');
        const head = /"migrationsHead": "(\d{4})"/.exec(manifest)?.[1] ?? '';
        state.dbHead = state.migrateTo?.[env.REMYRAL_VERSION] ?? head;
      }
      return exit(0);
    }
    case 'exec': {
      const cmd = tail.filter((a) => a !== '-T');
      if (cmd[0] === 'master' && cmd[2] === 'setup:token') {
        if (state.users > 0) {
          process.stderr.write('error: an account exists already\n');
          return exit(3);
        }
        state.tokens = (state.tokens ?? 0) + 1;
        print(`rst_${'a'.repeat(31)}${'bcdefghijk'[state.tokens % 10]}`);
        return exit(0);
      }
      if (cmd[0] === 'master' && cmd[2] === 'doctor') {
        if (state.doctorMissing) {
          process.stderr.write('usage: remyral-master [serve|migrate|…]\n');
          return exit(64);
        }
        print('FAIL db.migrations: 1 migration is pending');
        print('ok   redis.ping: Redis answers');
        return exit(state.doctorErrors ? 1 : 0);
      }
      return exit(0);
    }
    case 'stop':
      for (const svc of tail.filter((a) => !a.startsWith('-')))
        if (state.containers[svc]) state.containers[svc].running = false;
      return exit(0);
    case 'down':
      state.containers = {};
      if (tail.includes('--volumes')) state.dbHead = '';
      return exit(0);
    default:
      process.stderr.write(`fake compose: unsupported ${sub}\n`);
      return exit(2);
  }
}

function main() {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'version':
      print('27.3.1');
      return exit(0);
    case 'compose':
      return compose(rest);
    case 'network': {
      const [sub, name] = rest;
      if (sub === 'inspect') return exit(state.networks.includes(name) ? 0 : 1);
      if (sub === 'create') state.networks.push(name);
      if (sub === 'rm') state.networks = state.networks.filter((n) => n !== name);
      return exit(0);
    }
    case 'image': {
      const ref = rest.at(-1);
      const img = state.images[ref];
      if (!img) return exit(1);
      if (rest.includes('--format')) for (const d of img.repoDigests) print(d);
      return exit(0);
    }
    case 'pull': {
      const ref = rest.at(-1);
      const repo = ref.split('@')[0];
      state.images[ref] = {
        repoDigests: [state.wrongDigest ? `${repo}@sha256:${'0'.repeat(64)}` : ref],
      };
      return exit(0);
    }
    case 'ps': {
      const svc = rest.find((a) => a.startsWith('label=com.docker.compose.service='))?.split('=')[2];
      const c = state.containers[svc];
      if (c?.running) print(c.id);
      return exit(0);
    }
    case 'inspect': {
      const found = byId(rest.at(-1));
      if (!found) return exit(1);
      const format = rest[rest.indexOf('--format') + 1];
      print(format.includes('Config.Image') ? found[1].image : found[1].health);
      return exit(0);
    }
    case 'stop': {
      const found = byId(rest.at(-1));
      if (found) found[1].running = false;
      return exit(0);
    }
    case 'start': {
      const found = byId(rest.at(-1));
      if (found) found[1].running = true;
      return exit(0);
    }
    case 'exec': {
      const sql = rest[rest.indexOf('-tAc') + 1];
      if (rest.includes('-tAc')) {
        if (sql.includes('schema_migrations')) print(state.dbHead);
        else if (sql.includes('users')) print(String(state.users));
        return exit(0);
      }
      if (rest.includes('remyral-backup') && rest.includes('drill')) {
        // p17-host-actions: a restore drill (failDrill: it fails).
        const backupId = rest.includes('--backup') ? rest[rest.indexOf('--backup') + 1] : null;
        state.drills = [...(state.drills ?? []), backupId];
        print(`{\n  "runId": "drill-1",\n  "outcome": "${state.failDrill ? 'failed' : 'passed'}"\n}`);
        return exit(state.failDrill ? 1 : 0);
      }
      if (rest.includes('remyral-backup')) {
        if (state.failBackup) {
          process.stderr.write('backup failed: disk full\n');
          return exit(1);
        }
        const runId = 'remana-prod-20261023T120000Z';
        // p17-panel-settings Part 0: which recipients the archive of this run would be encrypted to.
        const recFile = process.env.FAKE_RECIPIENTS_FILE;
        const recipients =
          recFile && existsSync(recFile)
            ? readFileSync(recFile, 'utf8')
                .split('\n')
                .filter((l) => l.startsWith('age1'))
            : [];
        state.backups.push({ runId, dbHead: state.dbHead, recipients });
        print(`{\n  "runId": "${runId}",\n  "outcome": "ok"\n}`);
        return exit(0);
      }
      if (rest.some((a) => a.includes('RENAME TO remyral_replaced_'))) {
        state.dbHead = state.backups.at(-1)?.dbHead ?? state.dbHead;
      }
      return exit(0);
    }
    case 'cp':
      return exit(0);
    default:
      process.stderr.write(`fake docker: unsupported ${cmd}\n`);
      return exit(2);
  }
}

main();
