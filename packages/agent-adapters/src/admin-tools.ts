import {
  ADMIN_MCP_SERVER,
  type AdminOp,
  AdminOp as AdminOpSchema,
  MAX_ADMIN_COMMAND,
  MAX_ADMIN_FILE_BYTES,
  MAX_ADMIN_TIMEOUT_SEC,
  normalizeAdminPurpose,
} from '@remyral/protocol';
import { z } from 'zod';

/**
 * Machine-administration tools of a `machine-admin` job (p5-machine-admin, ADR-0021). The adapter registers them
 * as an in-process MCP server (no port, no process); every call goes to the worker's {@link AdminToolHost}, which
 * asks the master to sign it (approval or auto-approve), hands it to the elevated root/SYSTEM broker and returns
 * the redacted result. The runtime's own permission prompt is skipped for these tools — the master's gate is the
 * one that counts (and is cryptographically enforced by the broker).
 */

/** What the agent said about one elevated operation (p17-worker-1-1-1; unverified, never signed). */
export interface AdminToolMeta {
  /** One line: why the command is needed now (normalised, at most 300 characters). */
  readonly purpose?: string;
}

export interface AdminToolHost {
  /** Runs one elevated operation (never throws; `ok: false` with the reason as text). */
  run(
    op: AdminOp,
    signal?: AbortSignal,
    meta?: AdminToolMeta,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Appends a note to the machine's memory (what was installed or changed). */
  note(text: string): Promise<{ readonly ok: boolean; readonly text: string }>;
}

export const ADMIN_TOOL_PREFIX = `mcp__${ADMIN_MCP_SERVER}__`;

/**
 * p17-worker-1-1-1: the `purpose` argument of the elevated tools. The approver sees it above the command, labelled as
 * the agent's unverified explanation. Optional in the schema so a call without it still runs (the leading `#` comment
 * of the command is used then), but the description asks for it on every call.
 */
const PURPOSE = z
  .string()
  .max(2000)
  .optional()
  .describe(
    'Required: one sentence — why this command is needed now, in the user’s language. Shown to the human who approves it.',
  );

export const ADMIN_TOOLS = {
  admin_exec: {
    description:
      'Run ONE command elevated (root on Linux/macOS, SYSTEM/Administrator on Windows) on this machine. Every call is logged and, unless full access is allowed, waits for a human approval in the console. Always give `purpose`: one sentence, in the user’s language, why this command is needed now (the approver reads it above the command). shell: "powershell" or "cmd" on Windows, "sh" or "bash" on Linux/macOS. Prefer idempotent commands; never print secrets.',
    input: {
      purpose: PURPOSE,
      shell: z.enum(['powershell', 'cmd', 'sh', 'bash']),
      command: z.string().min(1).max(MAX_ADMIN_COMMAND),
      cwd: z.string().min(2).max(1024).optional(),
      timeoutSec: z.number().int().min(1).max(MAX_ADMIN_TIMEOUT_SEC).optional(),
    },
  },
  admin_write_file: {
    description:
      'Write a file elevated (absolute path). mode "create" fails if it exists, "overwrite" replaces it, "append" appends. The change (path, size, SHA-256 before and after) is logged; approval rules as for admin_exec. Always give `purpose` (one sentence, in the user’s language: why this change is needed now).',
    input: {
      purpose: PURPOSE,
      path: z.string().min(2).max(1024),
      content: z.string().max(MAX_ADMIN_FILE_BYTES),
      encoding: z.enum(['utf8', 'base64']).optional(),
      mode: z.enum(['create', 'overwrite', 'append']),
    },
  },
  admin_read_file: {
    description:
      'Read a file elevated (absolute path; for files the worker account cannot read). Logged; approval rules as for admin_exec. Always give `purpose` (one sentence, in the user’s language: why you need to read it now).',
    input: {
      purpose: PURPOSE,
      path: z.string().min(2).max(1024),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024)
        .optional(),
    },
  },
  machine_note: {
    description:
      'Record in this machine’s memory what you installed, configured or found (one short paragraph). Later machine administration jobs on this machine read it. Never include secrets.',
    input: { text: z.string().min(1).max(4000) },
  },
} as const;

export type AdminToolName = keyof typeof ADMIN_TOOLS;
export const ADMIN_TOOL_NAMES = Object.keys(ADMIN_TOOLS) as AdminToolName[];

/**
 * p17-worker-1-1-1: the comment a command explains itself with, as the fallback purpose — a leading comment line
 * (`# …`; cmd `REM …` / `:: …`) or a trailing `# …` on the first line outside quotes (sh, bash, PowerShell). Null
 * when there is none. A shebang is not a comment.
 */
export function commandComment(shell: string, command: string): string | null {
  const lines = command.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#!'))?.trim() ?? '';
  if (first === '') return null;
  if (shell === 'cmd') {
    const m = /^(?:@?rem(?:\s+|$)|::\s*)(.*)$/i.exec(first);
    return m === null ? null : normalizeAdminPurpose(m[1]);
  }
  if (first.startsWith('#')) return normalizeAdminPurpose(first.replace(/^#+\s*/, ''));
  // A trailing comment on the first line: `#` after whitespace, outside single / double quotes.
  let quote: string | null = null;
  for (let i = 0; i < first.length; i += 1) {
    const c = first[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i += 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && i > 0 && /\s/.test(first[i - 1] ?? '')) {
      return normalizeAdminPurpose(first.slice(i + 1).replace(/^#+\s*/, ''));
    }
  }
  return null;
}

/** The purpose of a call: the agent's `purpose` argument, else the command's own comment (exec only). */
export function adminPurposeFromTool(
  name: Exclude<AdminToolName, 'machine_note'>,
  args: Record<string, unknown>,
): string | null {
  const given = normalizeAdminPurpose(args.purpose);
  if (given !== null) return given;
  if (name === 'admin_exec' && typeof args.command === 'string' && typeof args.shell === 'string') {
    return commandComment(args.shell, args.command);
  }
  return null;
}

/**
 * Maps validated tool arguments to the protocol operation (plus the agent's purpose, when there is one); an error
 * text when they do not form one. The purpose never becomes part of the operation (it is not signed).
 */
export function adminOpFromTool(
  name: Exclude<AdminToolName, 'machine_note'>,
  args: Record<string, unknown>,
): { ok: true; op: AdminOp; purpose?: string } | { ok: false; error: string } {
  let candidate: unknown;
  if (name === 'admin_exec') {
    candidate = {
      kind: 'exec',
      shell: args.shell,
      command: args.command,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      timeoutSec: args.timeoutSec ?? 300,
    };
  } else if (name === 'admin_write_file') {
    const content =
      args.encoding === 'base64'
        ? String(args.content)
        : Buffer.from(String(args.content), 'utf8').toString('base64');
    candidate = { kind: 'write_file', path: args.path, content, mode: args.mode };
  } else {
    candidate = { kind: 'read_file', path: args.path, maxBytes: args.maxBytes ?? 64 * 1024 };
  }
  const parsed = AdminOpSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid arguments: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    };
  }
  const purpose = adminPurposeFromTool(name, args);
  return { ok: true, op: parsed.data, ...(purpose === null ? {} : { purpose }) };
}
