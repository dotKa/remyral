import { WORKFLOW_LIMITS } from '@remyral/scheduler';
import { z } from 'zod';
import { NODE_TYPES } from './catalog.js';
import { DataSchemaZ } from './data-schema.js';
import { expr } from './fields.js';
import { AiStepFields, Coordinate, Defaults, INPUT_NAME_PATTERN, WORKFLOW_NAME_PATTERN } from './v1.js';

/**
 * Definition document version 2 (p14-workflow-engine §2.1): typed nodes from the catalog with named ports, groups,
 * per-node error policy / retries / timeouts, typed inputs and run settings. A v1 document is a strict subset after
 * `normaliseV1` (convert.ts). Stored documents are never rewritten (append-only versions).
 */

export const V2_LIMITS = {
  maxNodes: 200,
  /** AI steps stay bounded as in v1 (cost). */
  maxAiNodes: WORKFLOW_LIMITS.maxNodes,
  maxEdges: 600,
  /** Ports of one node (switch: ≤ 20 cases + default + error + in). */
  maxPortsPerNode: 24,
  maxNesting: 3,
  maxDefinitionBytes: 512 * 1024,
  maxFanOut: 20,
  maxInputs: WORKFLOW_LIMITS.maxInputs,
  /** AI step retries (cost), other nodes up to `retry.max` 10. */
  maxAiRetries: WORKFLOW_LIMITS.maxRetries,
} as const;

export const PORT_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export const OnError = z.enum(['fail', 'continue', 'skip']);
export type OnError = z.infer<typeof OnError>;

export const Retry = z.strictObject({
  max: z.number().int().min(0).max(10).optional(),
  backoff: z.enum(['fixed', 'exponential']).optional(),
  initialSec: z.number().int().min(0).max(3600).optional(),
  maxSec: z.number().int().min(0).max(3600).optional(),
  jitter: z.boolean().optional(),
  on: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/))
    .max(20)
    .optional(),
  /** The author asserts the node is safe to repeat (non-idempotent methods / AI steps retry only then). */
  safe: z.boolean().optional(),
});
export type Retry = z.infer<typeof Retry>;

export const Join = z.union([
  z.enum(['all', 'any', 'first']),
  z.strictObject({ atLeast: z.number().int().min(1).max(20) }),
]);
export type Join = z.infer<typeof Join>;

/** Node-level fields every v2 node may carry. */
const Common = {
  label: z.string().max(80).optional(),
  /** The group (forEach / loop) this node belongs to. */
  parent: z.string().max(48).optional(),
  onError: OnError.optional(),
  retry: Retry.optional(),
  timeoutSec: z
    .number()
    .int()
    .min(1)
    .max(90 * 24 * 3600)
    .optional(),
  /** Join mode of a `many` input port (default all). */
  join: Join.optional(),
  /** Worker nodes: how long the job may wait for a capable worker (default 600 s) before failing `no_worker`. */
  queueTimeoutSec: z
    .number()
    .int()
    .min(10)
    .max(7 * 24 * 3600)
    .optional(),
};

export const AiStepNode = z.strictObject({
  type: z.literal('ai.step'),
  ...AiStepFields,
  /** The agent ends with a fenced `remyral-output` JSON block validated against this schema (14.1). */
  outputSchema: DataSchemaZ.optional(),
  ...Common,
});
export type AiStepNode = z.infer<typeof AiStepNode>;

const otherNodes = NODE_TYPES.filter((t) => t.type !== 'ai.step').map((t) =>
  z.strictObject({
    id: z.string().max(48),
    type: z.literal(t.type),
    config: z.preprocess((v) => v ?? {}, t.config),
    ...Common,
  }),
);

export const V2Node = z.discriminatedUnion('type', [AiStepNode, ...otherNodes] as unknown as [
  typeof AiStepNode,
  ...(typeof AiStepNode)[],
]);

/** A v2 node: an AI step (fields at node level) or a catalog node with its `config`. */
export type V2Node =
  | AiStepNode
  | {
      readonly id: string;
      readonly type: string;
      readonly config: Record<string, unknown>;
      readonly label?: string | undefined;
      readonly parent?: string | undefined;
      readonly onError?: OnError | undefined;
      readonly retry?: Retry | undefined;
      readonly timeoutSec?: number | undefined;
      readonly join?: Join | undefined;
      readonly queueTimeoutSec?: number | undefined;
    };

export const V2Edge = z.strictObject({
  from: z.string().max(48),
  to: z.string().max(48),
  /** Output port of `from` (default `out`). */
  fromPort: z.string().regex(PORT_NAME).optional(),
  /** Input port of `to` (default `in`). */
  toPort: z.string().regex(PORT_NAME).optional(),
});
export type V2Edge = z.infer<typeof V2Edge>;

export const InputSpecV2 = z.strictObject({
  required: z.boolean().default(false),
  description: z.string().max(500).optional(),
  type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
});

export const Settings = z.strictObject({
  concurrency: z
    .strictObject({
      max: z.number().int().min(1).max(50),
      onLimit: z.enum(['queue', 'skip', 'cancelOldest']).default('queue'),
      /** 14.4: one group per key (e.g. a customer id), an expression over `$inputs` / `$trigger`. */
      key: expr(z.string().max(200)).optional(),
    })
    .optional(),
  /** Whole-run limit from activation, paused time excluded (14.4). */
  timeoutSec: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 3600)
    .optional(),
  /** 14.4: the error workflow of the same project started when a run fails. */
  onFailure: z.strictObject({ workflow: z.string().regex(WORKFLOW_NAME_PATTERN) }).optional(),
  /** 14.4: node data of finished runs is pruned after this many days (default: the project's, else 30). */
  retentionDays: z.number().int().min(1).max(365).optional(),
  /** 14.4: notify the owners when this many runs in a row fail (default 3, 0 = off). */
  alerts: z.strictObject({ failuresInARow: z.number().int().min(0).max(100) }).optional(),
});

/** 14.4 defaults of the run settings. */
export const SETTINGS_DEFAULTS = { retentionDays: 30, failuresInARow: 3 } as const;

export const WorkflowDefinitionV2Body = z.strictObject({
  schemaVersion: z.literal(2),
  name: z.string().regex(WORKFLOW_NAME_PATTERN),
  description: z.string().max(1000).optional(),
  inputs: z.record(z.string().regex(INPUT_NAME_PATTERN), InputSpecV2).default({}),
  defaults: Defaults,
  settings: Settings.optional(),
  nodes: z.array(V2Node).min(1).max(V2_LIMITS.maxNodes),
  edges: z.array(V2Edge).max(V2_LIMITS.maxEdges),
  layout: z
    .strictObject({
      positions: z
        .record(z.string().max(48), z.strictObject({ x: Coordinate, y: Coordinate }))
        .refine((r) => Object.keys(r).length <= V2_LIMITS.maxNodes, { message: 'too_many' }),
    })
    .optional(),
});

export interface WorkflowDefinitionV2 {
  readonly schemaVersion: 2;
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputs: Readonly<
    Record<
      string,
      {
        readonly required: boolean;
        readonly description?: string | undefined;
        readonly type?: 'string' | 'number' | 'boolean' | 'json' | undefined;
      }
    >
  >;
  readonly defaults: z.infer<typeof Defaults>;
  readonly settings?: z.infer<typeof Settings> | undefined;
  readonly nodes: readonly V2Node[];
  readonly edges: readonly V2Edge[];
  readonly layout?: { readonly positions: Readonly<Record<string, { x: number; y: number }>> } | undefined;
}

export function isAiStep(n: V2Node): n is AiStepNode {
  return n.type === 'ai.step';
}
