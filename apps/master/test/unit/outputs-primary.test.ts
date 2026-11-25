import { describe, expect, it } from 'vitest';
import { primaryOutputKey } from '../../src/outputs/primary.js';
import type { OutputItem } from '../../src/outputs/service.js';

const JOB = '11111111-1111-4111-8111-111111111111';

function file(
  name: string,
  over: {
    preview?: string;
    at?: string;
    kind?: string;
    removed?: 'retention' | null;
    download?: string | null;
  } = {},
): OutputItem {
  return {
    key: `file:${JOB}:${name}`,
    type: 'file',
    project: 'acme',
    title: null,
    name,
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: over.at ?? '2026-10-22T10:00:00.000Z',
    site: null,
    file: {
      source: 'workspace',
      artifactId: name,
      kind: (over.kind ?? 'output') as 'output',
      mediaType: 'text/markdown',
      sizeBytes: 10,
      sha256: null,
      redacted: false,
      removed: over.removed ?? null,
      expiresAt: null,
      download: over.download === undefined ? `/api/x/${name}` : over.download,
      preview: (over.preview ?? 'markdown') as 'markdown',
      location: 'local',
    },
    note: null,
  };
}

describe('primaryOutputKey (p15-chat-cards-scroll "Raporu aç")', () => {
  it('prefers a report-like Markdown file: the summary artifact, then report words in order, shallow, newest', () => {
    const items = [
      file('notes.md', { at: '2026-10-22T12:00:00.000Z' }),
      file('docs/analysis.md'),
      file('README.md'),
      file('out/rapor.md'),
      file('rapor.md', { at: '2026-10-22T09:00:00.000Z' }),
    ];
    expect(primaryOutputKey(items)).toBe(`file:${JOB}:rapor.md`);
    expect(primaryOutputKey([...items, file('summary.md', { kind: 'summary' })])).toBe(
      `file:${JOB}:summary.md`,
    );
    expect(primaryOutputKey([file('Özet.md'), file('README.md')])).toBe(`file:${JOB}:Özet.md`);
    // A report-named file that is not Markdown is not a report: the newest document wins.
    expect(
      primaryOutputKey([
        file('report.pdf', { preview: 'pdf', at: '2026-10-22T11:00:00.000Z' }),
        file('notes.md'),
      ]),
    ).toBe(`file:${JOB}:report.pdf`);
  });

  it('else the newest readable document; removed, binary and download-less files never count', () => {
    expect(
      primaryOutputKey([
        file('a.txt', { preview: 'text', at: '2026-10-22T10:00:00.000Z' }),
        file('b.pdf', { preview: 'pdf', at: '2026-10-22T11:00:00.000Z' }),
        file('c.png', { preview: 'image', at: '2026-10-22T12:00:00.000Z' }),
        file('report.md', { removed: 'retention' }),
        file('summary.md', { download: null }),
      ]),
    ).toBe(`file:${JOB}:b.pdf`);
    expect(primaryOutputKey([file('c.png', { preview: 'image' })])).toBeNull();
    expect(primaryOutputKey([])).toBeNull();
    // Ties: the key decides (stable across calls).
    const t = '2026-10-22T10:00:00.000Z';
    expect(
      primaryOutputKey([
        file('b.txt', { preview: 'text', at: t }),
        file('a.txt', { preview: 'text', at: t }),
      ]),
    ).toBe(`file:${JOB}:a.txt`);
  });
});
