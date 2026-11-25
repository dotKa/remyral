import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpsUrl, outputQuery, parseOutputItem } from '../src/api/outputs';
import { parseDelimited } from '../src/screens/outputs/FileViewer';
import { parseLinks, parseTagText } from '../src/screens/outputs/format';

/**
 * p6-outputs: the Outputs screen — tabs, cards, the item drawer (site links outside the console, previews, notes),
 * multi-select ZIP and the safe previews (CSV table, sandboxed HTML, no raw HTML anywhere).
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-10-16T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const site = {
  key: 'site:pages:acme-site:preview',
  type: 'site',
  project: 'acme',
  title: null,
  name: 'acme-site',
  tags: ['launch'],
  pinned: true,
  noteCount: 1,
  jobId: JOB,
  createdAt: NOW,
  site: {
    url: 'https://abc.acme-site.pages.dev',
    env: 'preview',
    provider: 'pages',
    target: 'pages:acme-site',
    opsActionId: ACTION,
    opsKind: 'pages.deploy',
    deployedAt: NOW,
  },
  file: null,
  note: null,
};

function file(name: string, over: Record<string, unknown> = {}) {
  const id = `ws-${name.replace(/[^a-z0-9]+/g, '-')}`;
  return {
    key: `file:${JOB}:${id}`,
    type: 'file',
    project: 'acme',
    title: null,
    name,
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: NOW,
    site: null,
    file: {
      source: 'workspace',
      artifactId: id,
      kind: 'output',
      mediaType: 'text/markdown',
      sizeBytes: 120,
      sha256: 'a'.repeat(64),
      redacted: false,
      removed: null,
      expiresAt: null,
      download: `/jobs/${JOB}/artifacts/${id}`,
      preview: 'markdown',
      ...over,
    },
    note: null,
  };
}

describe('outputs api helpers', () => {
  it('builds the list query and parses items defensively (https links only, API paths only)', () => {
    expect(outputQuery({})).toBe('');
    expect(outputQuery({ type: 'file', q: 'a b', pinned: true, limit: 30, offset: 0 })).toBe(
      '?type=file&pinned=true&q=a+b&limit=30',
    );
    const evil = parseOutputItem({
      ...site,
      site: { ...site.site, url: 'javascript:alert(1)' },
    });
    expect(evil.site?.url).toBeNull();
    const f = parseOutputItem(file('a.md', { download: 'https://evil.example/x' }));
    expect(f.file?.download).toBeNull();
    expect(httpsUrl('http://x.example')).toBeNull();
    expect(httpsUrl('https://x.example/a')).toBe('https://x.example/a');
    expect(parseTagText(' a, b ,a,, ')).toEqual(['a', 'b']);
    expect(parseLinks('https://a.example\nhttps://b.example')).toEqual({
      links: ['https://a.example', 'https://b.example'],
      bad: null,
    });
    expect(parseLinks('javascript:alert(1)').bad).toBe('javascript:alert(1)');
  });

  it('splits CSV with quotes, doubled quotes and CRLF; bounds the rows', () => {
    expect(parseDelimited('a,"b,c"\r\n"x""y",2\n', ',')).toEqual([
      ['a', 'b,c'],
      ['x"y', '2'],
    ]);
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    const many = Array.from({ length: 1000 }, (_, i) => String(i)).join('\n');
    expect(parseDelimited(many, ',', 10)).toHaveLength(10);
  });
});
