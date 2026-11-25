import { z } from 'zod';

/**
 * The data contract of a port (p14-workflow-engine §2.2): a deliberately small JSON-Schema subset plus three platform
 * types — `text` (free text), `files` (workspace artifact references) and `git-ref` (`{branch, commits}` of AI steps).
 * Absent = any JSON. Used for design-time edge compatibility, runtime output contracts (14.1) and autocomplete.
 */
export const DATA_TYPES = [
  'any',
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
  'text',
  'files',
  'git-ref',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export interface DataSchema {
  readonly type: DataType;
  readonly description?: string | undefined;
  readonly properties?: Readonly<Record<string, DataSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly items?: DataSchema | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly maxLength?: number | undefined;
  readonly maxItems?: number | undefined;
}

export const MAX_SCHEMA_DEPTH = 6;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const DataSchemaZ: z.ZodType<DataSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum(DATA_TYPES),
    description: z.string().max(500).optional(),
    properties: z
      .record(z.string().regex(PROPERTY_NAME), DataSchemaZ)
      .refine((r) => Object.keys(r).length <= 64, { message: 'too_many' })
      .optional(),
    required: z.array(z.string().regex(PROPERTY_NAME)).max(64).optional(),
    items: DataSchemaZ.optional(),
    enum: z
      .array(z.union([z.string().max(200), z.number(), z.boolean()]))
      .min(1)
      .max(100)
      .optional(),
    maxLength: z
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024)
      .optional(),
    maxItems: z.number().int().min(0).max(10_000).optional(),
  }),
);

/** Nesting depth of a schema (1 = a flat type). */
export function schemaDepth(s: DataSchema): number {
  const kids = [...Object.values(s.properties ?? {}), ...(s.items === undefined ? [] : [s.items])];
  return 1 + kids.reduce((m, k) => Math.max(m, schemaDepth(k)), 0);
}

/**
 * Design-time compatibility of an output port's schema with an input port's (`edges.<i>:schema_mismatch` when false):
 * `any` (or an absent schema) connects to anything; `text` ↔ `string`; `integer` → `number`; objects need every
 * property the input requires, when the output declares its properties; arrays compare their items.
 */
export function compatible(out: DataSchema | undefined, input: DataSchema | undefined): boolean {
  if (out === undefined || input === undefined) return true;
  if (out.type === 'any' || input.type === 'any') return true;
  const norm = (t: DataType): DataType => (t === 'text' ? 'string' : t);
  const a = norm(out.type);
  const b = norm(input.type);
  if (a !== b && !(a === 'integer' && b === 'number')) return false;
  if (a === 'object' && out.properties !== undefined) {
    for (const k of input.required ?? []) {
      const p = out.properties[k];
      if (p === undefined) return false;
      if (!compatible(p, input.properties?.[k])) return false;
    }
  }
  if (a === 'array') return compatible(out.items, input.items);
  return true;
}
