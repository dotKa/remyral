import { describe, expect, it } from 'vitest';
import { computeLinks, mentionedProjects } from '../../src/search/chat-knowledge.js';
import {
  CHAT_CHUNK_CHARS,
  chatChunks,
  chatSnippet,
  MAX_CHAT_CHUNKS,
  redactChatText,
  stillSecret,
} from '../../src/search/chat-text.js';

/** p10-semantic-defaults-chat: deterministic project links and chunking of chat messages (§12.2–12.3). */

const TOKEN = `ghp_${'Q1w2E3r4T5'.repeat(4)}`;

type Role = 'user' | 'assistant' | 'tool' | 'error';
const msg = (
  id: string,
  seq: number,
  role: Role,
  turn: string | null,
  meta: Record<string, unknown> | null = null,
) => ({
  id,
  seq,
  role,
  turn_id: turn,
  meta,
});

describe('computeLinks', () => {
  it('the thread project links every user message and answer, never tool or error rows', () => {
    const links = computeLinks(
      'kp',
      [
        msg('u1', 1, 'user', null),
        msg('t1', 2, 'tool', 'T1'),
        msg('a1', 3, 'assistant', 'T1'),
        msg('e1', 4, 'error', 'T1'),
      ],
      [],
    );
    expect([...links.keys()].sort()).toEqual(['a1', 'u1']);
    expect(links.get('u1')?.get('kp')).toBe('thread');
  });

  it('a mention links the message and the answers of its turn; a draft links its turn; other turns stay private', () => {
    const links = computeLinks(
      null,
      [
        msg('u1', 1, 'user', null, { mentions: [{ type: 'project', id: 'alpha', label: 'Alpha' }] }),
        msg('a1', 2, 'assistant', 'T1'),
        msg('u2', 3, 'user', null),
        msg('t2', 4, 'tool', 'T2', { name: 'draft_job' }),
        msg('a2', 5, 'assistant', 'T2'),
        msg('u3', 6, 'user', null, { mentions: [{ type: 'job', id: 'x', project: 'beta' }] }),
        msg('a3', 7, 'assistant', 'T3'),
      ],
      [{ turn_id: 'T2', project: 'beta' }],
    );
    expect(links.get('u1')?.get('alpha')).toBe('mention');
    expect(links.get('a1')?.get('alpha')).toBe('mention');
    expect(links.get('u2')?.get('beta')).toBe('draft');
    expect(links.get('a2')?.get('beta')).toBe('draft');
    // A job mention is not a project mention; turn 3 has no draft.
    expect(links.has('u3')).toBe(false);
    expect(links.has('a3')).toBe(false);
  });

  it('a user message without an answer yet has no turn links; invalid project ids are ignored', () => {
    const links = computeLinks(
      null,
      [msg('u1', 1, 'user', null, { mentions: [{ type: 'project', id: '../etc' }] })],
      [{ turn_id: 'T9', project: 'kp' }],
    );
    expect(links.size).toBe(0);
    expect(
      mentionedProjects({
        mentions: [
          { type: 'project', id: 'ok' },
          { type: 'project', id: 'ok' },
        ],
      }),
    ).toEqual(['ok']);
  });
});

describe('chat chunks', () => {
  it('redacts secrets before anything is cut or sent', () => {
    const text = redactChatText(`deploy with ${TOKEN} now`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTED');
    expect(stillSecret(text)).toBe(false);
    expect(stillSecret(`key ${TOKEN}`)).toBe(true);
  });

  it('packs paragraphs, cuts long ones at a boundary, caps the count', () => {
    const para = `${'word '.repeat(200).trim()}.`;
    const chunks = chatChunks([para, para, para].join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= CHAT_CHUNK_CHARS)).toBe(true);
    expect(chunks.every((c) => !c.startsWith(' ') && !c.endsWith(' '))).toBe(true);
    expect(chatChunks('x '.repeat(100_000)).length).toBe(MAX_CHAT_CHUNKS);
    expect(chatChunks('   ')).toEqual([]);
  });

  it('the snippet of chunk N is cut the same way the indexer cut it', () => {
    const content = `first part ${'a '.repeat(600)}\n\nrollbacks are documented here ${'b '.repeat(400)}`;
    const chunks = chatChunks(redactChatText(content));
    const last = chunks.length - 1;
    expect(chatSnippet(content, last)).toContain('rollbacks');
    expect(chatSnippet(content, 0).length).toBeLessThanOrEqual(240);
  });
});
