import { describe, expect, it } from 'vitest';
import { prepareFile } from '../src/screens/chat/attachment-files';

describe('chat attachment thumbnail', () => {
  it('uses a data: URL (the console CSP allows img-src data: but not blob:)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const file = new File([png], 'shot.png', { type: 'image/png' });
    const p = await prepareFile(file, new Date('2026-10-17T00:00:00Z'));
    expect(p.previewUrl?.startsWith('data:image/')).toBe(true);
    expect(p.previewUrl).toContain(';base64,');
  });

  it('has no preview for text files', async () => {
    const p = await prepareFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(p.previewUrl).toBeNull();
  });
});
