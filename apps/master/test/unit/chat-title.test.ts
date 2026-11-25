import { describe, expect, it } from 'vitest';
import {
  normalizeChatTitle,
  titleAsk,
  titleBlock,
  titleWorthy,
  renameRequested,
} from '../../src/chat/title.js';

/** p17-chat-github Part 1 (docs/design/p17-chat-github.md §1): the pure title rules. */
describe('conversation title rules', () => {
  it('a greeting, a lone word or nothing is not worth naming from; a request is', () => {
    for (const t of [
      'merhaba',
      'Selam, nasılsın?',
      'hi',
      'hello there',
      'test',
      '',
      '   ',
      'ok teşekkürler',
      'Kubernetes',
    ])
      expect(titleWorthy(t), t).toBe(false);
    for (const t of [
      'Coolify deploy neden başarısız oldu?',
      'merhaba, nginx ayarını yapar mısın',
      'Write a landing page for SampleWebApp',
    ])
      expect(titleWorthy(t), t).toBe(true);
  });

  it('asks from the first message while a placeholder, from the conversation on messages 3–5 when provisional', () => {
    expect(titleAsk('placeholder', 1)).toBe('first_message');
    expect(titleAsk('placeholder', 6)).toBeNull();
    expect(titleAsk('provisional', 1)).toBeNull();
    expect(titleAsk('provisional', 2)).toBeNull();
    expect(titleAsk('provisional', 3)).toBe('conversation');
    expect(titleAsk('provisional', 5)).toBe('conversation');
    expect(titleAsk('provisional', 6)).toBeNull();
    for (const s of ['default', 'auto', 'user'] as const) expect(titleAsk(s, 3)).toBeNull();
    const b = titleBlock('conversation', 'merhaba');
    expect(b).toContain('conversation title');
    expect(b).toContain('"request": "name_from_conversation"');
    expect(b).toContain('set_chat_title');
  });

  it('normalises a title: one line, no quotes, ≤ 60 characters, never a secret', () => {
    expect(normalizeChatTitle('  “Coolify deploy hatası.”  ')).toBe('Coolify deploy hatası');
    expect(normalizeChatTitle('# Başlık\nikinci satır')).toBe('Başlık ikinci satır');
    const long = normalizeChatTitle('Bir çok uzun başlık '.repeat(10)) ?? '';
    expect(Array.from(long).length).toBeLessThanOrEqual(60);
    expect(normalizeChatTitle('')).toBeNull();
    expect(normalizeChatTitle(42)).toBeNull();
    expect(normalizeChatTitle('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB anahtarı')).toBeNull();
  });
});

describe('renameRequested (p18-plan-mode, owner 2026-10-28)', () => {
  it('recognises a request to rename the conversation, not a mere mention of a name', () => {
    for (const t of [
      'bu sohbetin adını yeniden adlandırır mısın',
      'bu sohbetin adını “Deploy notları” yap',
      'sohbetin başlığını değiştir',
      'rename this chat to Release notes',
      'change the title of this conversation',
    ])
      expect(renameRequested(t), t).toBe(true);
    for (const t of ['veritabanı yedekleri nerede?', 'işin adını değiştir', 'Deploy the app named web'])
      expect(renameRequested(t), t).toBe(false);
  });
});
