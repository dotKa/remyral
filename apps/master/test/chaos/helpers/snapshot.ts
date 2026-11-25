import { execFileSync } from 'node:child_process';
import pg from 'pg';

/**
 * p11-master-resilience: a consistent logical snapshot (`pg_dump -Fc`, the backup service's own format) of a database
 * on the dev Postgres container — found by its published port — and its restore into a NEW database next to it. The
 * restore-from-standby scenario starts a master on the restored copy: the control plane comes back with older state
 * (everything after the snapshot is the RPO window and is lost).
 */
export function snapshotDatabase(url: string): Buffer {
  const u = new URL(url);
  return execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${decodeURIComponent(u.password)}`,
      devPostgresContainer(u),
      'pg_dump',
      '-h',
      '127.0.0.1',
      '-U',
      decodeURIComponent(u.username),
      '-d',
      u.pathname.slice(1),
      '--format=custom',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
}

/** Restores `dump` into a new database `name` on the same server as `url`; returns the new database's URL. */
export async function restoreSnapshot(url: string, dump: Buffer, name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('bad database name');
  const u = new URL(url);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${decodeURIComponent(u.password)}`,
      devPostgresContainer(u),
      'pg_restore',
      '-h',
      '127.0.0.1',
      '-U',
      decodeURIComponent(u.username),
      '-d',
      name,
      '--exit-on-error',
      '--no-owner',
    ],
    { input: dump, maxBuffer: 64 * 1024 * 1024 },
  );
  const restored = new URL(url);
  restored.pathname = `/${name}`;
  return restored.toString();
}

export async function dropDatabase(url: string, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('bad database name');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function devPostgresContainer(u: URL): string {
  const id = execFileSync('docker', ['ps', '-q', '--filter', `publish=${u.port || '5432'}`], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')[0];
  if (id === undefined || id === '')
    throw new Error(`no running container publishes Postgres port ${u.port}`);
  return id;
}
