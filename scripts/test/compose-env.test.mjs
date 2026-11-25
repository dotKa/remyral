import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// p10-semantic-memory (docs/design/p10-semantic-memory.md §3, §8): the AWS credentials for Bedrock embeddings reach
// the master container only, as optional variables, and no embedding model runs in the control-plane compose project.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = readFileSync(join(root, 'infra/coolify/compose.yaml'), 'utf8');
const lines = compose.split('\n');

/** The lines of the top-level block starting at `header` (until the next unindented line). */
function block(header) {
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) throw new Error(`no block ${header}`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** The lines of one service under `services:`. */
function service(name) {
  const svc = block('services:');
  const start = svc.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const out = [];
  for (const l of svc.slice(start + 1)) {
    if (/^ {2}\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

const AWS_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'];
const SEARCH_VARS = ['SEARCH_BEDROCK_REGION', 'SEARCH_BEDROCK_MODEL', 'SEARCH_BEDROCK_DIMENSIONS'];

describe('control-plane compose: Bedrock embedding settings', () => {
  it('passes the AWS and Bedrock variables only through the master environment, optional and empty by default', () => {
    const env = block('x-master-env: &master-env');
    for (const v of [
      ...AWS_VARS,
      ...SEARCH_VARS,
      'MEMORY_SUGGEST_INTERVAL_MS',
      'MEMORY_DUPLICATE_THRESHOLD',
      'MEMORY_CHAT_PER_THREAD_DAY',
      'MEMORY_AUTO_LEARN',
      'RELATED_WORK',
      'RELATED_WORK_CONTEXT',
    ]) {
      expect(env, v).toContain(`  ${v}: \${${v}:-}`);
    }
    // Every mention of an AWS credential variable is inside the master environment block (or a comment).
    const mentions = lines.filter(
      (l) => !/^\s*#/.test(l) && /\bAWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\b/.test(l),
    );
    expect(mentions.every((l) => env.includes(l))).toBe(true);
    expect(mentions).toHaveLength(3);
  });

  it('merges the master environment into the master service only', () => {
    expect(compose.match(/\*master-env/g)).toHaveLength(1);
    expect(service('master').join('\n')).toContain('<<: *master-env');
    for (const name of ['web', 'migrate', 'postgres', 'redis', 'backup']) {
      expect(service(name).join('\n'), name).not.toMatch(/master-env|AWS_|SEARCH_BEDROCK/);
    }
  });

  it('runs no embedding model on the control plane (owner decision 2026-10-18)', () => {
    expect(compose).not.toMatch(/text-embeddings-inference|ollama|embeddings:\s*$/m);
    const names = block('services:')
      .filter((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l))
      .map((l) => l.trim().slice(0, -1));
    // p10-backup-restore added `backup` (profile; reads stack.env into its encrypted archive, never as environment).
    expect(names.sort()).toEqual(['backup', 'master', 'migrate', 'postgres', 'redis', 'web']);
  });
});

// p17-host-actions (docs/design/p17-host-actions.md §2): compose passes the master's environment as an explicit list, so
// a variable apps/master/src/config.ts reads but compose does not pass silently does nothing when an operator sets it
// in stack.env / Coolify. Every variable of the master's EnvSchema is passed in each install layout, or listed here
// with the reason it is deliberately not passed.

/** The keys of `const EnvSchema = z.object({ … })` in config.ts (two-space indented `NAME:` lines). */
function configKeys() {
  const text = readFileSync(join(root, 'apps/master/src/config.ts'), 'utf8').split('\n');
  const start = text.findIndex((l) => l.startsWith('const EnvSchema = z.object({'));
  const end = text.findIndex((l, i) => i > start && l === '});');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [
    ...new Set(
      text
        .slice(start + 1, end)
        .map((l) => /^ {2}([A-Z][A-Z0-9_]+):/.exec(l)?.[1])
        .filter(Boolean),
    ),
  ];
}

/** Variable names of a compose `environment:` mapping given as its lines (`    NAME: value` at `indent`). */
function envNames(blockLines, indent) {
  const re = new RegExp(`^ {${String(indent)}}([A-Z][A-Z0-9_]+):`);
  return blockLines.map((l) => re.exec(l)?.[1]).filter(Boolean);
}

/** The master's environment in infra/coolify/compose.yaml: the `x-master-env` anchor plus the service's own keys. */
function coolifyMasterEnv() {
  const svc = service('master');
  const i = svc.findIndex((l) => l === '    environment:');
  const own = [];
  for (const l of i < 0 ? [] : svc.slice(i + 1)) {
    if (!/^ {6}/.test(l)) break;
    own.push(l);
  }
  return new Set([...envNames(block('x-master-env: &master-env'), 2), ...envNames(own, 6)]);
}

/** The master environment the self-hosted overlay adds (infra/selfhost/compose.selfhost.yaml). */
function selfhostOverlayEnv() {
  const overlay = readFileSync(join(root, 'infra/selfhost/compose.selfhost.yaml'), 'utf8').split('\n');
  const m = overlay.findIndex((l) => l === '  master:');
  const e = overlay.findIndex((l, i) => i > m && l === '    environment:');
  const out = [];
  for (const l of overlay.slice(e + 1)) {
    if (!/^ {6}/.test(l)) break;
    out.push(l);
  }
  return new Set(envNames(out, 6));
}

/**
 * Deliberately not passed, per layout, with the reason. Adding a variable to config.ts without passing it fails this
 * test until it is passed or listed here.
 */
const NOT_PASSED = {
  coolify: {
    HOST_APPLIER_DIR:
      'only a remyral-ctl host has the host applier; compose.selfhost.yaml sets it with the shared directory mount',
  },
  selfhost: {},
};

describe('control-plane compose: every master setting reaches the master (p17-host-actions)', () => {
  const keys = configKeys();
  const layouts = {
    coolify: coolifyMasterEnv(),
    selfhost: new Set([...coolifyMasterEnv(), ...selfhostOverlayEnv()]),
  };

  it('reads the setting names from config.ts', () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const k of [
      'DATABASE_URL',
      'VERSION_CATALOG',
      'WORKER_FEED_URL',
      'RATE_LIMIT_SCALE',
      'HOST_APPLIER_DIR',
    ])
      expect(keys).toContain(k);
  });

  for (const [layout, passed] of Object.entries(layouts)) {
    it(`${layout}: each variable config.ts reads is passed or listed as deliberately not passed`, () => {
      const allow = NOT_PASSED[layout];
      const missing = keys.filter((k) => !passed.has(k) && !Object.hasOwn(allow, k));
      expect(missing, `pass these in the master environment or list them in NOT_PASSED.${layout}`).toEqual(
        [],
      );
      // The allowlist stays honest: nothing listed is passed anyway or unknown to config.ts.
      for (const k of Object.keys(allow)) {
        expect(passed.has(k), `${k} is passed; remove it from NOT_PASSED.${layout}`).toBe(false);
        expect(keys, `${k} is not read by config.ts`).toContain(k);
        expect(allow[k].length).toBeGreaterThan(20);
      }
    });
  }

  it('optional settings default to empty (empty = the config default), never to a value of their own', () => {
    const env = block('x-master-env: &master-env');
    for (const v of [
      'VERSION_CATALOG',
      'WORKER_FEED_URL',
      'RATE_LIMIT_SCALE',
      'METRICS_ENABLED',
      'GITHUB_API_URL',
    ])
      expect(env, v).toContain(`  ${v}: \${${v}:-}`);
  });
});
