import {
  normaliseV1,
  schemaVersionOf,
  toV1,
  typesDeliveredBy,
  validateV2,
  type WorkflowDefinition,
  WorkflowDefinitionBody,
} from '@remyral/workflow-nodes';
import type { Queryable } from '../../db/pool.js';

/**
 * p14-workflow-engine §5.7: the dry run before engine 2 takes over version-1 documents — every stored definition
 * is normalised (`normaliseV1`), validated as v2 (with only the node types engine 2 executes), serialised and
 * converted back (`toV1`); the result must equal the stored document. Read-only; reports ids and issue codes only
 * (prompts may be sensitive).
 *
 * 14.5 (the `WORKFLOW_ENGINE_V2_FOR_V1` switch): it also reports what the switch changes — how many workflows (latest
 * version, not archived) are version-1 documents whose **new** runs will start on engine 2, and how many runs are open
 * on each engine. Open engine-1 runs are not migrated: they finish on engine 1 (the engine is fixed per run).
 */
export interface NormaliseReport {
  readonly total: number;
  readonly v1: number;
  readonly v2: number;
  readonly failures: readonly { readonly id: string; readonly reason: string }[];
  /** Workflows (latest version, not archived) stored as version 1: their new runs move to engine 2 with the switch. */
  readonly v1Workflows: number;
  /** Open runs per engine (engine 1: starting / running / awaiting_merge; engine 2: queued / active / paused). */
  readonly openRuns: { readonly engine1: number; readonly engine2: number };
}

/** The node types engine 2 executes since 14.3 (what a normalised v1 document may contain: `ai.step` only). */
const EXECUTABLE = typesDeliveredBy('14.3');

export async function checkStoredDefinitions(db: Queryable, batch = 500): Promise<NormaliseReport> {
  let total = 0;
  let v1 = 0;
  let v2 = 0;
  const failures: { id: string; reason: string }[] = [];
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await db.query<{ id: string; definition: unknown }>(
      'SELECT id::text AS id, definition FROM workflow_definitions WHERE id > $1::uuid ORDER BY id LIMIT $2',
      [after, batch],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      total++;
      after = r.id;
      const version = schemaVersionOf(r.definition);
      if (version === 2) {
        v2++;
        const v = validateV2(r.definition);
        if (!v.ok) failures.push({ id: r.id, reason: `v2_invalid:${v.issues.map((i) => i.code).join(',')}` });
        continue;
      }
      v1++;
      const parsed = WorkflowDefinitionBody.safeParse(r.definition);
      if (!parsed.success) {
        failures.push({ id: r.id, reason: 'v1_unparseable' });
        continue;
      }
      const stored = JSON.parse(JSON.stringify(normaliseV1(parsed.data))) as unknown;
      const valid = validateV2(stored, { available: EXECUTABLE });
      if (!valid.ok) {
        failures.push({ id: r.id, reason: `v2_invalid:${valid.issues.map((i) => i.code).join(',')}` });
        continue;
      }
      const back: WorkflowDefinition | null = toV1(valid.def);
      if (back === null || JSON.stringify(back) !== JSON.stringify(parsed.data)) {
        failures.push({ id: r.id, reason: 'round_trip_differs' });
      }
    }
  }
  const latest = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM workflow_definitions d
      WHERE d.version = (SELECT max(x.version) FROM workflow_definitions x
                          WHERE x.project = d.project AND x.name = d.name)
        AND COALESCE(d.definition->>'schemaVersion', '1') <> '2'
        AND NOT EXISTS (SELECT 1 FROM workflow_archives a WHERE a.project = d.project AND a.name = d.name)`,
  );
  const open = await db.query<{ engine: number; n: string }>(
    `SELECT engine, count(*)::text AS n FROM workflow_runs
      WHERE (engine = 1 AND state IN ('starting', 'running', 'awaiting_merge'))
         OR (engine = 2 AND state IN ('queued', 'active', 'paused'))
      GROUP BY engine`,
  );
  const openOf = (e: number): number => Number(open.rows.find((r) => r.engine === e)?.n ?? 0);
  return {
    total,
    v1,
    v2,
    failures,
    v1Workflows: Number(latest.rows[0]?.n ?? 0),
    openRuns: { engine1: openOf(1), engine2: openOf(2) },
  };
}

/** The dry run's report as the lines `workflow:normalise-check` prints (ids and codes only). */
export function reportLines(r: NormaliseReport): string[] {
  const lines = [
    `workflow definitions: ${String(r.total)} (v1 ${String(r.v1)}, v2 ${String(r.v2)}), failures: ${String(r.failures.length)}`,
    ...r.failures.slice(0, 100).map((f) => `  ${f.id} ${f.reason}`),
    `WORKFLOW_ENGINE_V2_FOR_V1=true: new runs of ${String(r.v1Workflows)} version-1 workflow(s) start on engine 2`,
    `open runs: engine 1 ${String(r.openRuns.engine1)} (finish on engine 1), engine 2 ${String(r.openRuns.engine2)}`,
    r.failures.length === 0
      ? 'ready: every stored definition runs unchanged on engine 2'
      : 'NOT ready: fix or archive the failing definitions before switching',
  ];
  return lines;
}
