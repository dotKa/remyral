import { CapabilityTagName, RuntimeKind, SUBTASK_LIMITS, SubtaskPath } from '@remyral/protocol';
import { z } from 'zod';

/**
 * p8-orchestration (ADR-0031, docs/design/p8-orchestration.md §3): the sub-job tools of a job whose project lets its
 * agent delegate. The adapter registers them over a tool channel inside the runtime's own process (Claude Code: an
 * in-process MCP server like the machine-admin tools; Codex: app-server dynamic tools; Pi: an extension whose calls come
 * back as RPC UI requests — no port, no process; OpenCode: a local stdio MCP server OpenCode starts itself, relayed through
 * files in the attempt state dir — ADR-0045); every call goes to the worker's {@link SubtaskToolHost}, which asks
 * the master over the job's live lease. The runtime's own permission prompt is skipped for these tools — the master decides (project switch,
 * runtime allowlist, depth / fan-out / budget limits) and the sub-job's own approvals apply to what it does.
 */

export const SUBTASK_MCP_SERVER = 'remyral-subtasks';
export const SUBTASK_TOOL_PREFIX = `mcp__${SUBTASK_MCP_SERVER}__`;

export interface SubtaskToolHost {
  /** Creates a sub-job (and, with `wait`, waits for it up to `waitSec`). Never throws: `ok: false` with the reason. */
  request(
    args: {
      readonly title: string;
      readonly prompt: string;
      readonly runtime?: RuntimeKind | undefined;
      readonly requires?: readonly string[] | undefined;
      readonly inputs?: readonly string[] | undefined;
      /** p11-merge-pipeline: the files / directories the sub-job owns (advisory; see `SubtaskPath`). */
      readonly paths?: readonly string[] | undefined;
      readonly wait: boolean;
      readonly waitSec?: number | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Waits for a sub-job up to `waitSec` (0: its state now). */
  wait(
    subtaskId: string,
    waitSec: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
  cancel(subtaskId: string): Promise<{ readonly ok: boolean; readonly text: string }>;
}

const WaitSec = z.number().int().min(0).max(SUBTASK_LIMITS.maxWaitSec);

export const SUBTASK_TOOLS = {
  request_subtask: {
    description:
      'Hand one self-contained piece of work to a NEW agent job (a sub-job) that may run on another machine and with another runtime — e.g. image generation with runtime "codex" (requires ["image-generation"]). Describe the task completely: the sub-job does not see this conversation, only your prompt and the input files you list (paths relative to your working directory, e.g. "out/script.md"; small files only). With wait=true (default) the call waits up to waitSec (default 540) and returns the sub-job\'s result summary and the files it produced (copied into in/subtasks/<id>/); if it is not done yet, call wait_subtask later. The platform decides which runtimes and how many sub-jobs are allowed; its sandbox and approval rules equal or exceed yours. ' +
      'Repository projects: state `paths` — the files/directories this sub-job owns and is expected to change, e.g. ["src/api/", "docs/api.md"]; give sibling sub-jobs disjoint paths and do not edit them yourself — the platform merges all sub-job branches into ONE integration branch at the end and overlapping edits cause merge conflicts.',
    input: {
      title: z
        .string()
        .min(1)
        .max(SUBTASK_LIMITS.maxTitleChars)
        .describe(
          'a short imperative title in the user\'s language, at most 60 characters (e.g. "API hata kodlarını sadeleştir"); it names the sub-job in lists and pull requests — put every detail in prompt',
        ),
      prompt: z.string().min(1).max(SUBTASK_LIMITS.maxPromptChars),
      runtime: RuntimeKind.optional(),
      requires: z.array(CapabilityTagName).max(SUBTASK_LIMITS.maxRequires).optional(),
      inputs: z.array(z.string().min(1).max(300)).max(SUBTASK_LIMITS.maxInputs).optional(),
      paths: z
        .array(SubtaskPath)
        .max(SUBTASK_LIMITS.maxPaths)
        .optional()
        .describe(
          'files/directories this sub-job owns and is expected to change, e.g. ["src/api/", "docs/api.md"]; give sibling sub-jobs disjoint paths — the platform merges all sub-job branches into ONE integration branch at the end and overlapping edits cause merge conflicts',
        ),
      wait: z.boolean().optional(),
      waitSec: WaitSec.optional(),
    },
  },
  wait_subtask: {
    description:
      'Wait for a sub-job created with request_subtask (up to waitSec seconds, default 540; 0 = report its state now). When it has finished, returns its result summary and the files copied into in/subtasks/<id>/.',
    input: { subtaskId: z.uuid(), waitSec: WaitSec.optional() },
  },
  cancel_subtask: {
    description: 'Cancel a sub-job you created (it stops; its results are not delivered).',
    input: { subtaskId: z.uuid() },
  },
} as const;

export type SubtaskToolName = keyof typeof SUBTASK_TOOLS;
export const SUBTASK_TOOL_NAMES = Object.keys(SUBTASK_TOOLS) as SubtaskToolName[];

export interface SubtaskToolSpec {
  /** A sub-job tool name — or, on a shared job-tool channel (p12-deploy-feedback), a deploy tool name. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the input (strict object, no `$schema`). */
  readonly inputSchema: Record<string, unknown>;
}

/**
 * The sub-job tools with JSON Schema inputs, for runtimes that declare tools as JSON Schema (Codex dynamic tools,
 * Pi extension tools); derived from the same zod inputs {@link runSubtaskTool} validates with.
 */
export function subtaskToolSpecs(): SubtaskToolSpec[] {
  return SUBTASK_TOOL_NAMES.map((name) => {
    const schema = z.toJSONSchema(z.strictObject(SUBTASK_TOOLS[name].input), {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: SUBTASK_TOOLS[name].description, inputSchema: schema };
  });
}

/** True for exactly the sub-job tool names. */
export function isSubtaskToolName(name: string): name is SubtaskToolName {
  return (SUBTASK_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatches one validated tool call to the host (shared by the adapters and the fake runtime). */
export async function runSubtaskTool(
  host: SubtaskToolHost,
  name: SubtaskToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string }> {
  const parsed = z.strictObject(SUBTASK_TOOLS[name].input).safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      text: `invalid arguments: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    };
  }
  const a = parsed.data as Record<string, unknown>;
  switch (name) {
    case 'request_subtask':
      return host.request(
        {
          title: a.title as string,
          prompt: a.prompt as string,
          runtime: a.runtime as RuntimeKind | undefined,
          requires: a.requires as string[] | undefined,
          inputs: a.inputs as string[] | undefined,
          paths: a.paths as string[] | undefined,
          wait: (a.wait as boolean | undefined) ?? true,
          waitSec: a.waitSec as number | undefined,
        },
        signal,
      );
    case 'wait_subtask':
      return host.wait(a.subtaskId as string, a.waitSec as number | undefined, signal);
    case 'cancel_subtask':
      return host.cancel(a.subtaskId as string);
  }
}
