import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CONTEXT_LEAD,
  assistantPrompt,
  type AssistantTurnAttachment,
  ClaudeAssistantEngine,
  claudeUserContent,
  CodexAssistantEngine,
  codexTurnInput,
  FakeAssistantEngine,
  OpenCodeAssistantEngine,
  openCodePromptParts,
  PiAssistantEngine,
  piPromptCommand,
} from '../src/index.js';

/**
 * p8-chat-attachments-mentions: the exact model input each engine builds for a turn with attachments and a context
 * block (shapes verified against the pinned types: Agent SDK 0.3.296 / @anthropic-ai/sdk 0.133.0, codex-cli 0.162.1
 * generated v2 UserInput, pi 1.1.0 rpc-types + pi-ai 1.1.0 ImageContent, @opencode-ai/sdk 1.19.0 FilePartInput).
 */

const png: AssistantTurnAttachment = {
  kind: 'image',
  mediaType: 'image/png',
  name: 'shot.png',
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
};
const webp: AssistantTurnAttachment = {
  kind: 'image',
  mediaType: 'image/webp',
  name: 'b.webp',
  data: Buffer.from('RIFF\0\0\0\0WEBPVP8 '),
};
const pdf: AssistantTurnAttachment = {
  kind: 'pdf',
  mediaType: 'application/pdf',
  name: 'doc.pdf',
  data: Buffer.from('%PDF-1.4'),
};
const b64 = (a: AssistantTurnAttachment): string => a.data.toString('base64');
const turn = {
  message: 'Explain the error in the screenshot',
  history: '<<<REMYRAL-DATA conversation so far>>>',
  context: '<<<REMYRAL-DATA mention project genel>>>',
};

describe('assistantPrompt with context (p8-chat-attachments-mentions)', () => {
  it('orders history, context (with its lead) and the message', () => {
    const p = assistantPrompt(turn);
    const h = p.indexOf('conversation so far');
    const lead = p.indexOf(ASSISTANT_CONTEXT_LEAD);
    const c = p.indexOf('mention project genel');
    const m = p.indexOf("The user's new message:\nExplain");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(lead).toBeGreaterThan(h);
    expect(c).toBeGreaterThan(lead);
    expect(m).toBeGreaterThan(c);
  });

  it('keeps the old prompt without context, and context alone without history', () => {
    expect(assistantPrompt({ message: 'Hi', history: null })).toBe('Hi');
    expect(assistantPrompt({ message: 'Hi', history: 'H' })).toBe("H\n\nThe user's new message:\nHi");
    expect(assistantPrompt({ message: 'Hi', history: null, context: 'C' })).toBe(
      `${ASSISTANT_CONTEXT_LEAD}\nC\n\nThe user's new message:\nHi`,
    );
    expect(assistantPrompt({ message: 'Hi', history: null, context: null })).toBe('Hi');
  });
});

describe('engine input per runtime', () => {
  it('reports what each engine takes', () => {
    const base = { command: () => null, stateRoot: '/nonexistent' };
    expect(new ClaudeAssistantEngine({ binary: () => null }).input).toEqual({
      images: 'supported',
      pdf: true,
    });
    expect(new CodexAssistantEngine(base).input).toEqual({ images: 'supported', pdf: false });
    expect(new PiAssistantEngine(base).input).toEqual({ images: 'model-dependent', pdf: false });
    expect(new OpenCodeAssistantEngine(base).input).toEqual({ images: 'model-dependent', pdf: false });
    expect(new FakeAssistantEngine().input).toEqual({ images: 'supported', pdf: true });
  });

  it('Claude Code: text block, then base64 image blocks and PDF document blocks', () => {
    expect(claudeUserContent({ ...turn, attachments: [png, pdf] })).toEqual([
      { type: 'text', text: assistantPrompt(turn) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) },
        title: 'doc.pdf',
      },
    ]);
    expect(claudeUserContent(turn)).toBe(assistantPrompt(turn));
  });

  it('Codex: text input then data-URL image inputs; a PDF becomes a note', () => {
    expect(codexTurnInput({ ...turn, attachments: [png, webp] })).toEqual([
      { type: 'text', text: assistantPrompt(turn), text_elements: [] },
      { type: 'image', url: `data:image/png;base64,${b64(png)}` },
      { type: 'image', url: `data:image/webp;base64,${b64(webp)}` },
    ]);
    const withPdf = codexTurnInput({ ...turn, attachments: [pdf] });
    expect(withPdf).toHaveLength(1);
    expect(withPdf[0]).toMatchObject({ type: 'text' });
    expect((withPdf[0] as { text: string }).text).toContain('[PDF doc.pdf not readable by this engine]');
    expect(codexTurnInput(turn)).toEqual([{ type: 'text', text: assistantPrompt(turn), text_elements: [] }]);
  });

  it('Pi: prompt command with images (type, data, mimeType)', () => {
    expect(piPromptCommand({ ...turn, attachments: [png] })).toEqual({
      type: 'prompt',
      message: assistantPrompt(turn),
      images: [{ type: 'image', data: b64(png), mimeType: 'image/png' }],
    });
    expect(piPromptCommand(turn)).toEqual({ type: 'prompt', message: assistantPrompt(turn) });
    expect(piPromptCommand({ ...turn, attachments: [pdf] }).message).toContain('[PDF doc.pdf not readable');
  });

  it('OpenCode: text part then file parts with data URLs', () => {
    expect(openCodePromptParts({ ...turn, attachments: [png] })).toEqual([
      { type: 'text', text: assistantPrompt(turn) },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'shot.png',
        url: `data:image/png;base64,${b64(png)}`,
      },
    ]);
    expect(openCodePromptParts(turn)).toEqual([{ type: 'text', text: assistantPrompt(turn) }]);
  });

  it('the fake engine records attachments and context', async () => {
    const engine = new FakeAssistantEngine();
    const session = await engine.start({
      cwd: '/tmp',
      authMode: 'secret-ref',
      secretEnv: {},
      tools: { call: () => Promise.resolve({ content: '', isError: false }) },
      systemPrompt: 'x',
      timeouts: { startupMs: 1, turnMs: 1000, cancelGraceMs: 1 },
    });
    const r = await session.turn(
      { message: 'look', history: null, context: 'CTX', attachments: [png] },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r.text).toContain('saw 1 attachment(s): shot.png image/png 9 bytes');
    expect(r.text).toContain('context: 3 chars');
    expect(engine.sessions[0]?.turns[0]?.attachments?.[0]?.name).toBe('shot.png');
  });
});
