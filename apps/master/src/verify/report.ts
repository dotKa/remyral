import { createHash } from 'node:crypto';
import { SiteBundle } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { blobs, rowContent } from '../blobs/registry.js';
import { isPng, LIMITS, parseVerifierReport, type ParsedReport, type Screenshot } from './model.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §3): reads what a verifier (or a post-deploy screenshot job)
 * returned. A workspace verifier's files are ordinary job files (`verification/report.json`, `verification/*.png`); a
 * repository verifier returns them through the site-bundle mechanism (`remyral-verification/`), from which the master
 * stores the screenshots as ordinary job files of the verifier (so the console serves them through the existing
 * artifact route: `jobs.read`, nosniff, sandbox CSP). Everything here is untrusted input: sizes, the PNG signature and
 * names are checked; a bundle the secret scan flagged is never read.
 */

export interface VerifierFiles {
  readonly report: ParsedReport | null;
  readonly screenshots: Screenshot[];
  /** Why there is no report (for the reason text). */
  readonly problem: string | null;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export async function readVerifierFiles(db: Queryable, jobId: string): Promise<VerifierFiles> {
  const attempt = await db.query<{ current_attempt_id: string | null }>(
    'SELECT current_attempt_id::text AS current_attempt_id FROM jobs WHERE id = $1',
    [jobId],
  );
  const current = attempt.rows[0]?.current_attempt_id ?? null;
  // 1. Ordinary job files (workspace verifier, or a repository verifier's files stored earlier).
  const files = await db.query<{
    artifact_id: string;
    name: string;
    content: Buffer | null;
    blob_key: string | null;
    redacted: boolean;
    attempt_id: string;
  }>(
    `SELECT artifact_id, name, content, blob_key, redacted, attempt_id::text AS attempt_id FROM job_artifacts
      WHERE job_id = $1 AND kind = 'output' AND name LIKE 'verification/%'
        AND ($2::uuid IS NULL OR attempt_id = $2::uuid)
      ORDER BY created_at`,
    [jobId, current],
  );
  if (files.rows.some((f) => f.name === 'verification/report.json')) {
    // p17-object-storage: the files' bytes may be in the blob store (unreadable: treated like removed).
    const resolved = [];
    for (const f of files.rows) {
      resolved.push({ ...f, content: await rowContent(f, 16 * 1024 * 1024).catch(() => null) });
    }
    return fromArtifacts(jobId, resolved);
  }
  // 2. A repository verifier: the site bundle of `remyral-verification/`.
  const bundle = await db.query<{
    attempt_id: string;
    content: Buffer | null;
    blob_key: string | null;
    redacted: boolean;
  }>(
    `SELECT attempt_id::text AS attempt_id, content, blob_key, redacted FROM job_artifacts
      WHERE job_id = $1 AND kind = 'site' AND ($2::uuid IS NULL OR attempt_id = $2::uuid)
      ORDER BY created_at DESC LIMIT 1`,
    [jobId, current],
  );
  const row = bundle.rows[0];
  const b =
    row === undefined
      ? undefined
      : { ...row, content: await rowContent(row, 16 * 1024 * 1024).catch(() => null) };
  if (b === undefined) return { report: null, screenshots: [], problem: 'The verifier returned no report.' };
  if (b.redacted) {
    return {
      report: null,
      screenshots: [],
      problem: 'The verifier’s report folder looked like it contained a secret and was not read.',
    };
  }
  if (b.content === null)
    return { report: null, screenshots: [], problem: 'The report was removed by retention.' };
  let parsed: SiteBundle;
  try {
    const p = SiteBundle.safeParse(JSON.parse(b.content.toString('utf8')));
    if (!p.success) return { report: null, screenshots: [], problem: 'The report folder could not be read.' };
    parsed = p.data;
  } catch {
    return { report: null, screenshots: [], problem: 'The report folder could not be read.' };
  }
  const byPath = new Map(parsed.files.map((f) => [f.path, Buffer.from(f.base64, 'base64')]));
  const report = parseVerifierReport(byPath.get('report.json') ?? null);
  if (report === null) {
    return { report: null, screenshots: [], problem: 'The verifier wrote no valid report.json.' };
  }
  const shots: Screenshot[] = [];
  let n = 0;
  for (const s of report.screenshots) {
    const content = byPath.get(s.file);
    if (content === undefined || content.length > LIMITS.screenshotBytes || !isPng(content)) continue;
    const artifactId = `ws-verify-shot-${String(n++)}`;
    const name = `verification/${s.file}`;
    // p17-object-storage: the screenshot goes to the blob store like every job file.
    const done = await db.query('SELECT 1 FROM job_artifacts WHERE attempt_id = $1 AND artifact_id = $2', [
      b.attempt_id,
      artifactId,
    ]);
    if ((done.rowCount ?? 0) === 0) {
      const key = await blobs().write(
        'artifact',
        `artifacts/${jobId}/${b.attempt_id}/${artifactId}`,
        content,
        'image/png',
      );
      await db.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                    redacted, content, blob_key, created_at)
         VALUES ($1, $2, $3, $4, 'image/png', $5, $6, 'output', false, NULL, $7, now())
         ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
        [
          b.attempt_id,
          jobId,
          artifactId,
          name,
          content.length,
          createHash('sha256').update(content).digest('hex'),
          key,
        ],
      );
    }
    shots.push({ jobId, artifactId, name, width: s.width });
  }
  return { report, screenshots: shots, problem: null };
}

function fromArtifacts(
  jobId: string,
  rows: readonly { artifact_id: string; name: string; content: Buffer | null; redacted: boolean }[],
): VerifierFiles {
  const reportRow = rows.find((f) => f.name === 'verification/report.json');
  if (reportRow === undefined || reportRow.content === null) {
    return { report: null, screenshots: [], problem: 'The verifier returned no report.' };
  }
  // A text file the worker / master redacted is still JSON-shaped at best; a redacted report is not trusted.
  if (reportRow.redacted) {
    return {
      report: null,
      screenshots: [],
      problem: 'The verifier’s report was redacted (secret scan) and not read.',
    };
  }
  const report = parseVerifierReport(reportRow.content);
  if (report === null)
    return { report: null, screenshots: [], problem: 'The verifier wrote no valid report.json.' };
  const byName = new Map(rows.map((r) => [r.name, r]));
  const shots: Screenshot[] = [];
  for (const s of report.screenshots) {
    if (!NAME.test(s.file)) continue;
    const r = byName.get(`verification/${s.file}`);
    if (r?.content == null || r.content.length > LIMITS.screenshotBytes || !isPng(r.content)) continue;
    shots.push({ jobId, artifactId: r.artifact_id, name: r.name, width: s.width });
  }
  return { report, screenshots: shots, problem: null };
}
