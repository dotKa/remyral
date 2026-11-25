import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { imageExtension, MAX_GENERATED_IMAGE_BYTES, saveGeneratedImage } from '../../../src/index.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const root = mkdtempSync(join(tmpdir(), 'remyral-codex-images-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function workspace(withOut = true): string {
  const ws = mkdtempSync(join(root, 'ws-'));
  if (withOut) mkdirSync(join(ws, 'out'));
  return ws;
}

const item = (over: Partial<Parameters<typeof saveGeneratedImage>[0]['item']> = {}) => ({
  id: 'ig_1',
  status: 'completed',
  result: PNG.toString('base64'),
  ...over,
});

describe('p8-codex-images: saveGeneratedImage', () => {
  it('detects PNG, JPEG and WebP by magic bytes only', () => {
    expect(imageExtension(PNG)).toBe('png');
    expect(imageExtension(JPG)).toBe('jpg');
    expect(imageExtension(WEBP)).toBe('webp');
    expect(imageExtension(Buffer.from('GIF89a'))).toBeNull();
  });

  it('copies the base64 result; never overwrites (numbered copy)', async () => {
    const ws = workspace();
    const a = await saveGeneratedImage({ item: item(), workspaceRoot: ws, codexHome: undefined });
    const b = await saveGeneratedImage({ item: item(), workspaceRoot: ws, codexHome: undefined });
    expect(a).toEqual({
      ok: true,
      path: 'out/generated-images/ig_1.png',
      text: 'image saved to out/generated-images/ig_1.png',
    });
    expect(b.path).toBe('out/generated-images/ig_1-2.png');
    expect(readFileSync(join(ws, a.path ?? '')).equals(PNG)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'reads savedPath only inside CODEX_HOME (realpath), else falls back to the result',
    async () => {
      const home = mkdtempSync(join(root, 'home-'));
      const saved = join(home, 'generated_images', 't', 'ig.jpg');
      mkdirSync(join(home, 'generated_images', 't'), { recursive: true });
      writeFileSync(saved, JPG);
      const ws = workspace();
      const inHome = await saveGeneratedImage({
        item: item({ id: 'ig_a', result: '', savedPath: saved }),
        workspaceRoot: ws,
        codexHome: home,
      });
      expect(inHome.path).toBe('out/generated-images/ig_a.jpg');
      // codex-cli 0.164.0: an attachment-store item has no inline result at all; savedPath alone is enough.
      const fileOnly = await saveGeneratedImage({
        item: { id: 'ig_f', status: 'completed', savedPath: saved },
        workspaceRoot: ws,
        codexHome: home,
      });
      expect(fileOnly.path).toBe('out/generated-images/ig_f.jpg');
      // A link inside CODEX_HOME pointing outside it is not followed out.
      const secret = join(root, 'secret.png');
      writeFileSync(secret, PNG);
      symlinkSync(secret, join(home, 'generated_images', 't', 'link.png'));
      const linked = await saveGeneratedImage({
        item: item({ id: 'ig_b', result: '', savedPath: join(home, 'generated_images', 't', 'link.png') }),
        workspaceRoot: ws,
        codexHome: home,
      });
      expect(linked.ok).toBe(false);
      expect(linked.text).toContain('no readable image data');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses non-images, oversized results, unfinished items and a symlinked target directory',
    async () => {
      const ws = workspace();
      const text = await saveGeneratedImage({
        item: item({ result: Buffer.from('hello').toString('base64') }),
        workspaceRoot: ws,
        codexHome: undefined,
      });
      expect(text).toMatchObject({ ok: false });
      const huge = await saveGeneratedImage({
        item: item({ result: 'A'.repeat(Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 100) }),
        workspaceRoot: ws,
        codexHome: undefined,
      });
      expect(huge).toMatchObject({
        ok: false,
        text: expect.stringContaining('no readable image data') as unknown,
      });
      expect(
        (
          await saveGeneratedImage({
            item: item({ status: 'failed' }),
            workspaceRoot: ws,
            codexHome: undefined,
          })
        ).ok,
      ).toBe(false);
      const ws2 = workspace();
      const elsewhere = mkdtempSync(join(root, 'elsewhere-'));
      symlinkSync(elsewhere, join(ws2, 'out', 'generated-images'));
      const linked = await saveGeneratedImage({ item: item(), workspaceRoot: ws2, codexHome: undefined });
      expect(linked).toMatchObject({
        ok: false,
        text: expect.stringContaining('is not a directory') as unknown,
      });
    },
  );

  it('writes nothing without out/ (repository job)', async () => {
    const ws = workspace(false);
    const r = await saveGeneratedImage({
      item: item({ savedPath: '/x/ig.png' }),
      workspaceRoot: ws,
      codexHome: undefined,
    });
    expect(r).toEqual({
      ok: true,
      text: 'image generated (Codex saved it at /x/ig.png); not copied: this job has no out/ directory',
    });
  });
});
