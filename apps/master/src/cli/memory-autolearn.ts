import { parseArgs } from 'node:util';
import { AuditLog } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { ConfigError, loadConfig } from '../config.js';
import { ContextPolicyService } from '../context/policy.js';
import { ContextStore } from '../context/store.js';
import { createPool } from '../db/pool.js';
import { MemoryRecordService } from '../memory-records/service.js';
import type { AutoLearnRunStats, TypeCounts } from '../memory-suggestions/autolearn-service.js';
import { MemorySuggestionService } from '../memory-suggestions/service.js';
import { BedrockIntegration } from '../search/bedrock-integration.js';
import { BedrockEmbedder } from '../search/bedrock.js';
import { envEmbedder } from '../search/env-embedder.js';
import { SearchService } from '../search/service.js';

/**
 * `node dist/cli/memory-autolearn.js [--dry-run] [--project <id> …] [--json]` (p17-auto-learning §6): runs the
 * auto-learning policy over the pending memory suggestions — merges near-duplicates (TR/EN twins by meaning), accepts
 * what is safe under each project's setting, leaves the rest for a person — and prints counts per outcome, by project
 * and type. `--dry-run` writes nothing (texts of consented projects may still be embedded to compare them). Idempotent:
 * a second real run only re-states what stays with a person.
 *
 * It uses the master's own configuration and embedding provider (Settings → Integrations → AWS Bedrock first, then
 * SEARCH_PROVIDER), so run it inside the master container:
 *   docker exec -w /app/apps/master <master> node dist/cli/memory-autolearn.js --dry-run
 * Exit: 0 done, 2 could not run.
 */

const COLS: readonly (keyof TypeCounts)[] = ['merged', 'known', 'accepted', 'expiring', 'human'];

function table(stats: AutoLearnRunStats): string {
  const lines: string[] = [];
  lines.push(
    `${stats.dryRun ? 'DRY RUN — nothing was written' : 'APPLIED'} (auto-learning policy v${String(stats.policyVersion)})`,
  );
  lines.push('');
  lines.push(['project', 'mode', 'by', 'type', 'pending', ...COLS].join('\t'));
  for (const p of stats.projects) {
    for (const [type, c] of Object.entries(p.byType)) {
      if (COLS.every((k) => c[k] === 0)) continue;
      lines.push(
        [
          p.project,
          p.mode,
          p.semantic ? 'meaning' : 'words',
          type,
          '',
          ...COLS.map((k) => String(c[k])),
        ].join('\t'),
      );
    }
    lines.push(
      [
        p.project,
        p.mode,
        p.semantic ? 'meaning' : 'words',
        'ALL',
        String(p.pending),
        ...COLS.map((k) => String(p.totals[k])),
      ].join('\t'),
    );
    const reasons = Object.entries(p.humanReasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length > 0) {
      lines.push(`  left for a person because: ${reasons.map(([r, n]) => `${r} ${String(n)}`).join(', ')}`);
    }
  }
  lines.push('');
  lines.push(
    `total: ${COLS.map((k) => `${k} ${String(stats.totals[k])}`).join(', ')}  (merged = folded into a twin, known = already in memory, expiring = accepted with a 14-day expiry)`,
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      project: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const config = loadConfig();
  const box = await SecretBox.fromKeyFile(config.totpKeyFile);
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 4,
    applicationName: 'remyral-memory-autolearn',
  });
  try {
    const clock = (): Date => new Date();
    const audit = new AuditLog(pool, clock);
    const holder: { search: SearchService | null } = { search: null };
    const context = new ContextStore({
      pool,
      audit,
      clock,
      relevance: (project, prompt) =>
        holder.search?.promptRelevance(project, prompt) ?? Promise.resolve(null),
    });
    const policy = new ContextPolicyService({ pool, audit, clock }, context);
    const search = new SearchService({ pool, audit, policy, embedder: null, clock });
    holder.search = search;
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
    const records = new MemoryRecordService({
      pool,
      audit,
      context,
      clock,
      similar: async (project, text) => (await search.similarDocs(project, [text]))?.[0] ?? null,
    });
    const suggestions = new MemorySuggestionService({
      pool,
      audit,
      context,
      search,
      records,
      clock,
      duplicateThreshold: config.memorySuggestions.duplicateThreshold,
      log: {
        warn: (obj, msg) => {
          process.stderr.write(`warning: ${msg} ${JSON.stringify(obj)}\n`);
        },
      },
    });
    if (!config.memorySuggestions.autoLearn) {
      process.stderr.write(
        'MEMORY_AUTO_LEARN=off: auto-learning is switched off on this master; nothing to do.\n',
      );
      return 0;
    }
    const stats = await suggestions.autoLearnBackfill({
      dryRun: values['dry-run'],
      ...(values.project === undefined ? {} : { projects: values.project }),
      actor: { type: 'system', id: 'cli:memory-autolearn' },
    });
    process.stdout.write(values.json ? `${JSON.stringify(stats, null, 2)}\n` : `${table(stats)}\n`);
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
      `error: ${err instanceof ConfigError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected failure'}\n`,
    );
    process.exitCode = 2;
  },
);
