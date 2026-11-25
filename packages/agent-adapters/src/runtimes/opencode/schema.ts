import { z } from 'zod';

/**
 * Zod schemas for the subset of the OpenCode 1.19.0 server API the adapter
 * uses, derived from the OpenAPI document served by the pinned binary at
 * `GET /doc` (components `Session`, `PermissionRequest`, `Event*`, `ToolPart`,
 * `StepFinishPart`, `TextPart`, `AssistantMessage`). The `/event` SSE stream
 * carries dozens of event types (plugin, catalog, lsp, …); only the types in
 * `OC_CONSUMED_EVENTS` are interpreted and they are validated strictly — a
 * consumed event that does not match its schema fails the session
 * (`runtime_protocol_error`). Unconsumed types are ignored by design.
 */

export const OC_SESSION_ID = /^ses_[A-Za-z0-9]{1,80}$/;
export const OC_PERMISSION_ID = /^per[A-Za-z0-9_]{1,80}$/;
export const OC_QUESTION_ID = /^que[A-Za-z0-9_]{1,80}$/;

export const OcSession = z.looseObject({
  id: z.string().regex(OC_SESSION_ID),
  directory: z.string(),
  version: z.string().optional(),
  cost: z.number().optional(),
});
export type OcSession = z.infer<typeof OcSession>;

export const OcHealth = z.looseObject({ healthy: z.boolean(), version: z.string() });

export const OcTokens = z.looseObject({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.looseObject({ read: z.number(), write: z.number() }),
});

const ToolStateBase = { input: z.record(z.string(), z.unknown()).optional() };
export const OcToolState = z.discriminatedUnion('status', [
  z.looseObject({ status: z.literal('pending'), ...ToolStateBase }),
  z.looseObject({ status: z.literal('running'), ...ToolStateBase }),
  z.looseObject({ status: z.literal('completed'), ...ToolStateBase, output: z.string() }),
  z.looseObject({ status: z.literal('error'), ...ToolStateBase, error: z.string() }),
]);

/** Part types the mapper interprets (validated strictly); every other part type is ignored. */
export const OC_CONSUMED_PARTS: ReadonlySet<string> = new Set(['text', 'tool', 'step-finish']);

export const OcPart = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('text'),
    id: z.string(),
    messageID: z.string(),
    text: z.string(),
    synthetic: z.boolean().optional(),
    time: z.looseObject({ start: z.number(), end: z.number().optional() }).optional(),
  }),
  z.looseObject({
    type: z.literal('tool'),
    id: z.string(),
    messageID: z.string(),
    callID: z.string(),
    tool: z.string(),
    state: OcToolState,
  }),
  z.looseObject({
    type: z.literal('step-finish'),
    id: z.string(),
    messageID: z.string(),
    reason: z.string(),
    cost: z.number(),
    tokens: OcTokens,
  }),
]);
export type OcPart = z.infer<typeof OcPart>;

export const OcMessageInfo = z.looseObject({
  id: z.string(),
  role: z.string(),
  modelID: z.string().optional(),
  providerID: z.string().optional(),
  time: z.looseObject({ created: z.number(), completed: z.number().optional() }).optional(),
});

const OcError = z.looseObject({
  name: z.string().optional(),
  data: z.looseObject({ message: z.string().optional(), responseBody: z.unknown().optional() }).optional(),
});

const props = <S extends z.core.$ZodLooseShape>(shape: S) => z.looseObject(shape);

/** Consumed `/event` frames (`{id, type, properties}`). */
export const OcEvent = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('server.connected'), properties: z.unknown() }),
  z.looseObject({
    type: z.literal('session.status'),
    properties: props({
      sessionID: z.string(),
      status: z.looseObject({ type: z.enum(['idle', 'busy', 'retry']), message: z.string().optional() }),
    }),
  }),
  z.looseObject({ type: z.literal('session.idle'), properties: props({ sessionID: z.string() }) }),
  z.looseObject({
    type: z.literal('session.error'),
    properties: props({ sessionID: z.string().optional(), error: OcError.optional() }),
  }),
  z.looseObject({
    type: z.literal('message.updated'),
    properties: props({ sessionID: z.string(), info: OcMessageInfo }),
  }),
  z.looseObject({
    type: z.literal('message.part.updated'),
    // Parts of other types (reasoning, step-start, file, patch, …) pass; consumed ones are parsed with OcPart.
    properties: props({ sessionID: z.string(), part: z.looseObject({ type: z.string() }) }),
  }),
  z.looseObject({
    type: z.literal('permission.asked'),
    properties: props({
      id: z.string().regex(OC_PERMISSION_ID),
      sessionID: z.string(),
      permission: z.string(),
      patterns: z.array(z.string()),
      metadata: z.record(z.string(), z.unknown()).optional(),
      tool: z.looseObject({ messageID: z.string(), callID: z.string() }).optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('permission.replied'),
    properties: props({
      sessionID: z.string(),
      requestID: z.string(),
      reply: z.enum(['once', 'always', 'reject']),
    }),
  }),
  z.looseObject({
    type: z.literal('question.asked'),
    properties: props({ id: z.string(), sessionID: z.string() }),
  }),
  // Tamper signals: the adapter never creates PTYs or further sessions on its per-job server.
  z.looseObject({ type: z.literal('pty.created'), properties: z.unknown() }),
  z.looseObject({
    type: z.literal('session.created'),
    properties: props({ sessionID: z.string().optional(), info: z.looseObject({ id: z.string() }) }),
  }),
]);
export type OcEvent = z.infer<typeof OcEvent>;

export const OC_CONSUMED_EVENTS: ReadonlySet<string> = new Set([
  'server.connected',
  'session.status',
  'session.idle',
  'session.error',
  'message.updated',
  'message.part.updated',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'pty.created',
  'session.created',
]);

/** `GET /config` (effective configuration): only the permission map is checked. */
export const OcEffectiveConfig = z.looseObject({
  permission: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])).optional(),
  /** p14-codex-mcp-isolation: configured MCP servers by name (entries are checked for `enabled: false` only). */
  mcp: z.record(z.string(), z.unknown()).optional(),
});
