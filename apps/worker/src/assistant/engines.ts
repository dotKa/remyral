import { join } from 'node:path';
import {
  type AssistantCommand,
  type AssistantEngine,
  type AssistantRuntimeSettings,
  ClaudeAssistantEngine,
  CodexAssistantEngine,
  FakeAssistantEngine,
  OpenCodeAssistantEngine,
  PiAssistantEngine,
} from '@remyral/agent-adapters';
import type { AssistantRuntime, RuntimeKind } from '@remyral/protocol';

/**
 * The ops-chat assistant engines of this worker (p5-ops-chat-next): one per runtime, started with exactly
 * the executable, settings and pin policy jobs use (runtime registry, effective panel/local settings,
 * runtime policy `allowUnpinned`). Which one runs is the panel's choice (Settings → Chat); a runtime that is
 * not enabled or has no auth here is reported not ready by the host.
 */
export interface AssistantEngineWiring {
  readonly dataDir: string;
  readonly sourceEnv: NodeJS.ProcessEnv;
  /** The executable jobs start (registry: local config binary, managed install, or located). */
  readonly launch: (runtime: RuntimeKind) => AssistantCommand | null;
  /** Claude Code: the job binary, else the CLI bundled with the worker's Agent SDK (development checkouts). */
  readonly claudeBinary: () => Promise<string | null>;
  readonly settings: (runtime: RuntimeKind) => AssistantRuntimeSettings | undefined;
  readonly allowUnpinned: (runtime: RuntimeKind) => boolean;
  /** Development/tests: deterministic fake engines, no process, no model. */
  readonly fake: boolean;
}

export function createAssistantEngines(
  w: AssistantEngineWiring,
): Partial<Record<AssistantRuntime, AssistantEngine>> {
  if (w.fake) {
    return {
      'claude-code': new FakeAssistantEngine('claude-code'),
      codex: new FakeAssistantEngine('codex'),
      opencode: new FakeAssistantEngine('opencode'),
      pi: new FakeAssistantEngine('pi'),
    };
  }
  const stateRoot = (runtime: AssistantRuntime): string => join(w.dataDir, 'assistant-state', runtime);
  const base = (runtime: AssistantRuntime) => ({
    command: () => w.launch(runtime),
    stateRoot: stateRoot(runtime),
    sourceEnv: w.sourceEnv,
    allowUnpinned: () => w.allowUnpinned(runtime),
    settings: () => w.settings(runtime),
  });
  return {
    'claude-code': new ClaudeAssistantEngine({
      binary: () => w.claudeBinary(),
      stateDir: stateRoot('claude-code'),
      sourceEnv: w.sourceEnv,
      allowUnpinned: () => w.allowUnpinned('claude-code'),
    }),
    codex: new CodexAssistantEngine(base('codex')),
    opencode: new OpenCodeAssistantEngine(base('opencode')),
    pi: new PiAssistantEngine(base('pi')),
  };
}
