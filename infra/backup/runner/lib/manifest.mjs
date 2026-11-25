// Backup manifest (p10-backup-restore §3): plaintext JSON next to every backup and uploaded off-site last. It holds
// no secret: versions, the schema head, the audit head, row counts, SHA-256 fingerprints of a few rows, file hashes.
import { parseBackupId, TIERS } from './naming.mjs';

export const MANIFEST_FORMAT = 'remana-backup-manifest/v1';
const HEX64 = /^[0-9a-f]{64}$/;

function fail(msg) {
  throw new Error(`invalid manifest: ${msg}`);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;

function checkFile(f, name, { encrypted }) {
  if (!isObj(f)) fail(`${name} missing`);
  if (typeof f.name !== 'string' || !/^[a-z]+\/remana-[a-z0-9-]+-\d{8}T\d{6}Z\.[a-z.]+$/.test(f.name))
    fail(`${name}.name`);
  if (!isInt(f.bytes)) fail(`${name}.bytes`);
  if (!HEX64.test(f.sha256 ?? '')) fail(`${name}.sha256`);
  if (encrypted && !HEX64.test(f.plaintextSha256 ?? '')) fail(`${name}.plaintextSha256`);
}

/** Validates a parsed manifest; returns it unchanged or throws. */
export function validateManifest(m) {
  if (!isObj(m) || m.format !== MANIFEST_FORMAT) fail('format');
  const id = parseBackupId(m.id);
  if (!id) fail('id');
  if (m.env !== id.env) fail('env does not match id');
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) fail('createdAt');
  if (!TIERS.includes(m.tier)) fail('tier');
  if (!isObj(m.schema) || typeof m.schema.version !== 'string' || !isInt(m.schema.count)) fail('schema');
  if (!isObj(m.tables)) fail('tables');
  for (const [t, n] of Object.entries(m.tables)) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(t) || !isInt(n)) fail(`tables.${t}`);
  }
  if (!Array.isArray(m.fingerprints)) fail('fingerprints');
  for (const f of m.fingerprints) {
    if (!isObj(f) || typeof f.table !== 'string' || typeof f.id !== 'string' || !HEX64.test(f.sha256 ?? ''))
      fail('fingerprints[]');
  }
  if (
    m.auditHead !== null &&
    (!isObj(m.auditHead) || !/^\d+$/.test(m.auditHead.id ?? '') || !HEX64.test(m.auditHead.hash ?? ''))
  )
    fail('auditHead');
  if (!isObj(m.files)) fail('files');
  checkFile(m.files.db, 'files.db', { encrypted: false });
  if (m.files.secrets !== null) checkFile(m.files.secrets, 'files.secrets', { encrypted: true });
  if (
    !Array.isArray(m.recipients) ||
    m.recipients.some((r) => typeof r !== 'string' || !r.startsWith('age1'))
  )
    fail('recipients');
  if (m.offsite !== null && !isObj(m.offsite)) fail('offsite');
  return m;
}

export function buildManifest({
  id,
  env,
  createdAt,
  finishedAt,
  tier,
  dump,
  inspection,
  db,
  secrets,
  recipients,
}) {
  return validateManifest({
    format: MANIFEST_FORMAT,
    id,
    env,
    createdAt: createdAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    tier,
    postgres: {
      serverVersion: inspection.serverVersion,
      pgDumpVersion: dump.pgDumpVersion,
      format: 'custom',
      compression: 'zstd',
      snapshot: true,
    },
    schema: inspection.schema,
    auditHead: inspection.auditHead,
    tables: inspection.rowCounts,
    fingerprints: inspection.fingerprints,
    files: { db, secrets },
    recipients,
    offsite: null,
  });
}
