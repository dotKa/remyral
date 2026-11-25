import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_IMAGE_MAX_BYTES,
  ASSISTANT_IMAGE_TOOLS,
  ASSISTANT_IMAGES_FEATURE,
  ASSISTANT_TOOLS,
  AssistantImageCard,
  assistantToolDescription,
  assistantToolInput,
  assistantToolJsonSchema,
  WorkerFeature,
} from '../src/index.js';

/** p20-chat-images (docs/design/p20-chat-images.md): show_image, draft_screenshot, their feature and the image card. */
describe('assistant image tools (p20-chat-images)', () => {
  const JOB = '6f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b';

  it('come with a worker feature; show_image is a read, draft_screenshot a card', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_IMAGES_FEATURE);
    expect([...ASSISTANT_IMAGE_TOOLS].sort()).toEqual(['draft_screenshot', 'show_image']);
    expect(ASSISTANT_TOOLS.show_image.kind).toBe('read');
    expect(ASSISTANT_TOOLS.draft_screenshot.kind).toBe('draft');
    expect(assistantToolDescription('show_image')).toMatch(/^SHOW/);
    expect(assistantToolDescription('draft_screenshot')).toContain('draft_tool_install');
    for (const t of ASSISTANT_IMAGE_TOOLS) expect(assistantToolJsonSchema(t).type, t).toBe('object');
  });

  it('show_image takes ids or relative paths, at most 6', () => {
    const s = (v: unknown) => assistantToolInput('show_image').safeParse(v).success;
    expect(s({ jobId: JOB })).toBe(true);
    expect(s({ jobId: JOB, artifactIds: ['ws-a1b2'], caption: 'Ana sayfa' })).toBe(true);
    expect(s({ jobId: JOB, source: 'workfiles', paths: ['shots/home.png'] })).toBe(true);
    expect(s({ jobId: JOB, artifactIds: Array.from({ length: 7 }, (_, i) => `ws-${String(i)}`) })).toBe(
      false,
    );
    expect(s({ jobId: JOB, artifactIds: ['../etc'] })).toBe(false);
    expect(s({ jobId: JOB, paths: ['/etc/passwd'] })).toBe(false);
    expect(s({ jobId: JOB, paths: ['a/../b.png'] })).toBe(false);
    expect(s({ jobId: JOB, paths: ['a\\b.png'] })).toBe(false);
    expect(s({ jobId: JOB, paths: ['a\nb.png'] })).toBe(false);
    expect(s({ jobId: 'nope' })).toBe(false);
    expect(s({ jobId: JOB, url: 'https://x' })).toBe(false);
  });

  it('draft_screenshot takes 1–6 pages, two viewports and the draft flags', () => {
    const d = (v: unknown) => assistantToolInput('draft_screenshot').safeParse(v).success;
    expect(d({ urls: [{ url: 'https://example.com' }] })).toBe(true);
    expect(
      d({
        urls: [{ url: 'https://example.com', label: 'ana' }],
        viewports: ['desktop', 'mobile'],
        fullPage: true,
        waitMs: 2000,
        project: 'genel',
        execute: true,
      }),
    ).toBe(true);
    expect(d({ urls: [] })).toBe(false);
    expect(d({ urls: Array.from({ length: 7 }, () => ({ url: 'https://example.com' })) })).toBe(false);
    expect(d({ urls: [{ url: 'https://example.com' }], viewports: ['tablet'] })).toBe(false);
    expect(d({ urls: [{ url: 'https://example.com' }], waitMs: 60_000 })).toBe(false);
    expect(d({ urls: [{ url: 'https://example.com', extra: 1 }] })).toBe(false);
  });

  it('the card is closed: ids and a path, never a URL', () => {
    const ok = {
      source: 'output',
      jobId: JOB,
      artifactId: 'ws-abc',
      name: 'screenshots/01-home-desktop.png',
      mediaType: 'image/png',
      sizeBytes: 1234,
    };
    expect(AssistantImageCard.safeParse(ok).success).toBe(true);
    expect(
      AssistantImageCard.safeParse({
        source: 'workfile',
        jobId: JOB,
        path: 'out/a.webp',
        name: 'a.webp',
        mediaType: 'image/webp',
        sizeBytes: 1,
      }).success,
    ).toBe(true);
    expect(AssistantImageCard.safeParse({ ...ok, url: 'https://evil' }).success).toBe(false);
    expect(AssistantImageCard.safeParse({ ...ok, mediaType: 'image/svg+xml' }).success).toBe(false);
    expect(AssistantImageCard.safeParse({ ...ok, sizeBytes: ASSISTANT_IMAGE_MAX_BYTES + 1 }).success).toBe(
      false,
    );
    expect(
      AssistantImageCard.safeParse({ ...ok, source: 'workfile', artifactId: undefined, path: '../x.png' })
        .success,
    ).toBe(false);
  });
});
