import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, assistantToolInput } from '../src/assistant.js';
import { ChatArchiveNote, MAX_CHAT_ZIPS } from '../src/chat-input.js';
import { CHAT_SITE_ZIP, CHAT_ZIP_PROBLEMS, SITE_UPLOAD_LIMITS, siteProblems } from '../src/site-files.js';

const UUID = '7b0c4f1e-1d2a-4c3b-9a8e-0f1e2d3c4b5a';

describe('a .zip in the chat (p15-chat-zip)', () => {
  it('siteProblems: publishable only with index.html at the root and within the limits', () => {
    expect(siteProblems([{ path: 'index.html', size: 10 }])).toEqual([]);
    expect(siteProblems([])).toEqual(['no_files']);
    expect(siteProblems([{ path: 'site/index.html', size: 1 }])).toEqual(['no_index']);
    const many = Array.from({ length: SITE_UPLOAD_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: i === 0 ? 'index.html' : `p/${String(i)}.png`,
      size: 1,
    }));
    expect(siteProblems(many)).toEqual(['too_many_files']);
    expect(
      siteProblems([
        { path: 'index.html', size: 1 },
        { path: 'v.mp4', size: SITE_UPLOAD_LIMITS.maxTotalBytes },
      ]),
    ).toEqual(['too_large']);
    expect(siteProblems([{ path: 'a.css', size: SITE_UPLOAD_LIMITS.maxTotalBytes + 1 }])).toEqual([
      'no_index',
      'too_large',
    ]);
  });

  it('archive notes: a display name, counts and known problems only', () => {
    expect(MAX_CHAT_ZIPS).toBe(CHAT_SITE_ZIP.maxPerMessage);
    for (const p of CHAT_ZIP_PROBLEMS) {
      expect(
        ChatArchiveNote.safeParse({ name: 'x.zip', fileCount: 0, totalBytes: 0, problems: [p] }).success,
      ).toBe(true);
    }
    for (const name of ['', 'a/b.zip', 'a\\b.zip', 'line\nbreak.zip', 'x'.repeat(101)]) {
      expect(
        ChatArchiveNote.safeParse({ name, fileCount: 1, totalBytes: 1, problems: ['no_index'] }).success,
        name,
      ).toBe(false);
    }
    expect(
      ChatArchiveNote.safeParse({ name: 'x.zip', fileCount: -1, totalBytes: 1, problems: ['no_index'] })
        .success,
    ).toBe(false);
  });

  it('tools: list_site_uploads reads, publish_site_upload is a strict draft for one upload', () => {
    expect(ASSISTANT_TOOLS.list_site_uploads.kind).toBe('read');
    expect(ASSISTANT_TOOLS.publish_site_upload.kind).toBe('draft');
    const pub = assistantToolInput('publish_site_upload');
    expect(pub.safeParse({ uploadId: UUID }).success).toBe(true);
    expect(
      pub.safeParse({
        uploadId: UUID,
        env: 'production',
        pagesProject: 'my-deck',
        createIfMissing: true,
        domain: 'deck.demo.test',
        dns: 'auto',
        execute: true,
      }).success,
    ).toBe(true);
    expect(pub.safeParse({}).success).toBe(false);
    expect(pub.safeParse({ uploadId: 'nope' }).success).toBe(false);
    expect(pub.safeParse({ uploadId: UUID, project: 'other' }).success).toBe(false);
    expect(pub.safeParse({ uploadId: UUID, pagesProject: 'Bad_Name' }).success).toBe(false);
    expect(pub.safeParse({ uploadId: UUID, env: 'staging' }).success).toBe(false);
    expect(assistantToolInput('list_site_uploads').safeParse({ project: 'site', limit: 5 }).success).toBe(
      true,
    );
    expect(ASSISTANT_TOOLS.publish_site_upload.description).toContain("cloudflare'da yayınla");
  });
});
