import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * E2E environment derived from the repo's dev `.env` (pnpm dev:keygen): same Postgres/Redis credentials,
 * but a throw-away database (`remyral_e2e_web`) and a dedicated Redis logical DB, so the dev database and
 * the dev rate-limit counters are never touched. Values are passed to child processes, never printed.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const PORTS = {
  master: Number(process.env.E2E_MASTER_PORT ?? 18080),
  dev: Number(process.env.E2E_WEB_PORT ?? 5174),
  preview: Number(process.env.E2E_PREVIEW_PORT ?? 4174),
} as const;

/** Overridable so parallel worktrees can run e2e side by side (name must start with remyral_e2e_). */
export const E2E_DB_NAME = process.env.E2E_DB_NAME ?? 'remyral_e2e_web';
const E2E_REDIS_DB = `/${process.env.E2E_REDIS_DB ?? '15'}`;

export interface E2eEnv {
  readonly databaseUrl: string;
  readonly adminDbUrl: string;
  readonly redisUrl: string;
  readonly totpKeyFile: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. E2E needs the local dev stack: run \`pnpm dev:keygen && pnpm dev:up\` at the repo root.`,
    );
  }
  return v;
}

export function loadE2eEnv(): E2eEnv {
  const file = `${REPO_ROOT}.env`;
  if ((!process.env.DATABASE_URL || !process.env.REDIS_URL) && existsSync(file)) process.loadEnvFile(file);
  const base = new URL(required('DATABASE_URL'));
  const db = new URL(base);
  db.pathname = `/${E2E_DB_NAME}`;
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const redis = new URL(required('REDIS_URL'));
  redis.pathname = E2E_REDIS_DB;
  return {
    databaseUrl: db.toString(),
    adminDbUrl: admin.toString(),
    redisUrl: redis.toString(),
    totpKeyFile: required('TOTP_KEY_FILE'),
  };
}

export const MASTER_ORIGIN = `http://127.0.0.1:${String(PORTS.master)}`;
