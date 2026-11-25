import { parseArgs } from 'node:util';
import { AuditLog } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { ConfigError, loadConfig } from '../config.js';
import { ContextPolicyService } from '../context/policy.js';
import { ContextStore } from '../context/store.js';
import { createPool } from '../db/pool.js';
import { RelatedWorkService } from '../related/service.js';
import { BedrockIntegration } from '../search/bedrock-integration.js';
import { BedrockEmbedder } from '../search/bedrock.js';
import { envEmbedder } from '../search/env-embedder.js';
import { SearchService } from '../search/service.js';
import { BACKFILL_KINDS, type BackfillKind, searchBackfill } from '../search/backfill.js';

/**
 * `remyral-master search:backfill [--dry-run] [--kind <kind> …] [--batch N] [--rate N] [--max N] [--json]`
 * (p17-embeddings, docs/design/p17-embeddings.md §7): embeds what the indexer has not reached yet, at a bounded rate.
 *
 * Kinds: `job_summary` (the search index's job result summaries — and context documents, the same pass), `job_card`
 * (a job's title and the beginning of its prompt), `job_failure`, `workflow_failure`, `automation`; default all.
 * Only projects whose search capture is consented are read, secret-looking texts are never sent, and only missing
 * vectors are embedded — a second run does nothing (idempotent). `--dry-run` prints what is missing and sends nothing.
 *
 * It uses the master's own configuration and provider (Settings → Integrations → AWS Bedrock first, then
 * SEARCH_PROVIDER), so run it inside the master container:
 *   docker exec <master> remyral-master search:backfill --dry-run
 *   docker exec <master> remyral-master search:backfill --kind job_card --kind job_failure --rate 300
 * Exit: 0 done, 2 could not run.
 */

const KINDS = BACKFILL_KINDS;
type Kind = BackfillKind;

/** A wrong command line (printed as such, not as a configuration problem). */
class UsageError extends Error {
  override name = 'UsageError';
}

function positive(name: string, raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`--${name}: 1..${String(max)}`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      kind: { type: 'string', multiple: true },
      batch: { type: 'string' },
      rate: { type: 'string' },
      max: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const kinds: Kind[] = [];
  for (const k of values.kind ?? ['all']) {
    if (k === 'all') kinds.push(...KINDS);
    else if ((KINDS as readonly string[]).includes(k)) kinds.push(k as Kind);
    else throw new UsageError(`--kind: one of ${KINDS.join(', ')}, all`);
  }
  const batch = positive('batch', values.batch, 32, 256);
  /** Texts sent to the provider per minute (the rate limit of a run). */
  const rate = positive('rate', values.rate, 600, 10_000);
  const max = positive('max', values.max, 1_000_000, 1_000_000);
  const config = loadConfig();
  const box = await SecretBox.fromKeyFile(config.totpKeyFile);
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 4,
    applicationName: 'remyral-search-backfill',
  });
  try {
    const clock = (): Date => new Date();
    const audit = new AuditLog(pool, clock);
    const context = new ContextStore({ pool, audit, clock });
    const policy = new ContextPolicyService({ pool, audit, clock }, context);
    const search = new SearchService({ pool, audit, policy, embedder: null, clock });
    const env = await envEmbedder(config.search);
    const bedrock = new BedrockIntegration({
      pool,
      audit,
      box,
      clock,
      search,
      env: {
        mode: config.searchControl.mode,
        embedder: env,
        region: env instanceof BedrockEmbedder ? env.region : null,
        credentialSource: (process.env.AWS_ACCESS_KEY_ID ?? '') === '' ? 'instance role' : 'environment',
      },
    });
    await bedrock.refresh();
    const related = new RelatedWorkService({
      pool,
      search,
      audit,
      clock,
      enabled: config.relatedWork.enabled,
    });
    const embedder = search.embedder;
    if (embedder === null) {
      process.stderr.write('no embedding provider is configured on this master; nothing to do.\n');
      return 0;
    }
    if (!config.relatedWork.enabled && kinds.some((k) => k !== 'job_summary')) {
      process.stderr.write('RELATED_WORK=off: work vectors are switched off; only job_summary runs.\n');
    }
    // p17-panel-settings Part 7: the same core as the panel's maintenance job.
    const report = await searchBackfill(
      {
        pool,
        audit,
        search,
        related,
        relatedEnabled: config.relatedWork.enabled,
        actor: { type: 'system', id: 'cli:search-backfill' },
      },
      { kinds, dryRun: values['dry-run'], batch, rate, max },
    );
    if (report === null) return 0;
    const before = report.missingBefore;
    const done = report.embedded;
    const out = {
      dryRun: values['dry-run'],
      model: embedder.model,
      kinds,
      missingBefore: before,
      embedded: done,
    };
    if (values.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      const lines = [
        `${out.dryRun ? 'DRY RUN — nothing was sent or written' : 'APPLIED'} (model ${embedder.model})`,
        '',
        ['kind', 'missing', 'embedded'].join('\t'),
        ...kinds.map((k) => [k, String(before[k]), String(done[k])].join('\t')),
        '',
        'missing = items of consented projects without a vector (texts that look like secrets are never sent and stay missing)',
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof ConfigError ? err.message : err instanceof UsageError ? `usage: ${err.message}` : err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected failure'}\n`,
    );
    process.exitCode = 2;
  },
);
