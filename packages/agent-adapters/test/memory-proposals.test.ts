import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentEvent, parseMemoryProposals } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  ClaudeEventMapper,
  CodexEventMapper,
  OcEventMapper,
  type OcAction,
  PiEventMapper,
  PiInbound,
  type PiAction,
  SecretValue,
} from '../src/index.js';
import { assistantText } from './fixtures/claude-code/sdk-messages.js';

/**
 * p11-memory-layers: agents' learned experience. Every runtime adapter reports the agent's answer as an assistant
 * `message` event; the master reads `LESSON:` / `MEMORY:` lines from it (`parseMemoryProposals`, one rule for all four
 * runtimes). These tests push the same answer through each adapter's real event mapper (recorded transcripts for Pi
 * and OpenCode, SDK / app-server shapes for Claude Code and Codex) and check the proposals that come out — identical
 * for every runtime, and never carrying an injected secret.
 */

const SECRET = 'sk-live-memorytest-0123456789';
const ANSWER = [
  'Done: the build is green.',
  '',
  'LESSON: pnpm filter builds — run `pnpm --filter @remyral/web build` before the web tests, the dist is stale otherwise.',
  '- MEMORY: Deploy target — staging deploys go through Coolify app "web-staging".',
  '```',
  'LESSON: this one is inside a code block and is ignored',
  '```',
  `MEMORY: Token — the key is ${SECRET}`,
].join('\n');

const EXPECTED = [
  {
    type: 'lesson',
    title: 'pnpm filter builds',
    content:
      'pnpm filter builds: run `pnpm --filter @remyral/web build` before the web tests, the dist is stale otherwise.',
  },
  {
    type: 'fact',
    title: 'Deploy target',
    content: 'Deploy target: staging deploys go through Coolify app "web-staging".',
  },
];

function proposalsOf(events: readonly AgentEvent[]) {
  return events.flatMap((e) =>
    e.kind === 'message' && e.role === 'assistant' ? parseMemoryProposals(e.text) : [],
  );
}

/** The redacted third proposal never carries the secret (the mapper redacted the text before the master sees it). */
function checkRedacted(events: readonly AgentEvent[]): void {
  const all = proposalsOf(events);
  expect(all.slice(0, 2)).toEqual(EXPECTED);
  expect(JSON.stringify(all)).not.toContain(SECRET);
  expect(all).toHaveLength(3);
  expect(all[2]?.content).toContain('[REDACTED]');
}

const secrets = { API_KEY: new SecretValue(SECRET) };

describe('LESSON: / MEMORY: lines from real adapter output (all four runtimes)', () => {
  it('Claude Code: an assistant text block', () => {
    const m = new ClaudeEventMapper('secret-ref', secrets);
    checkRedacted(m.map(assistantText('6f1c9a52-0000-4000-8000-000000000001', ANSWER)));
  });

  it('Codex: a completed agentMessage item', () => {
    const m = new CodexEventMapper('secret-ref', secrets);
    m.map('turn/started', { threadId: 't', turn: { id: 'u', status: 'inProgress' } });
    checkRedacted(
      m.map('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'i1', text: ANSWER },
      }),
    );
  });

  it('Pi: the recorded basic transcript with the answer as its first assistant message', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'transcripts');
    const lines = readFileSync(join(dir, 'basic.jsonl'), 'utf8').trim().split('\n');
    let t = 0;
    const mapper = new PiEventMapper({ secrets, authMode: 'secret-ref', now: () => (t += 10) });
    const actions: PiAction[] = lines.flatMap((l) =>
      mapper.map(PiInbound.parse(JSON.parse(l.replaceAll('"ack"', JSON.stringify(ANSWER))))),
    );
    checkRedacted(actions.flatMap((a) => (a.kind === 'emit' ? [a.event] : [])));
  });

  it('OpenCode: the recorded basic /event frames with the answer as the final text part', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'transcripts');
    const frames = readFileSync(join(dir, 'basic.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l.replaceAll('"done"', JSON.stringify(ANSWER))) as unknown);
    const session = frames
      .map((f) => (f as { properties?: { sessionID?: unknown } }).properties?.sessionID)
      .find((s): s is string => typeof s === 'string');
    let t = 0;
    const mapper = new OcEventMapper({ secrets, authMode: 'secret-ref', now: () => (t += 10) });
    mapper.bind(session ?? '');
    const actions: OcAction[] = frames.flatMap((f) => mapper.map(f));
    checkRedacted(actions.flatMap((a) => (a.kind === 'emit' ? [a.event] : [])));
  });

  it('user prompts (which carry the MEMORY_PROPOSAL_NOTE template) are never read as proposals', () => {
    const m = new ClaudeEventMapper('secret-ref', {});
    const userEcho: AgentEvent[] = [{ kind: 'message', role: 'user', text: ANSWER }];
    expect(proposalsOf(userEcho)).toEqual([]);
    expect(proposalsOf(m.map(assistantText('s', 'LESSON: <short title> — <what worked or failed>')))).toEqual(
      [],
    );
  });
});
