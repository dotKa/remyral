import { configure, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/api/directory';
import { I18nProvider } from '../src/i18n/I18nProvider';
import {
  archiveNote,
  defaultProject,
  isZipFile,
  planChatZip,
  uploadProjects,
  zipDisplayName,
} from '../src/screens/chat/chat-zip';
import { MessageSiteZips } from '../src/screens/chat/ZipAttachments';
import { stubCookies } from './helpers';
import { SITE_ZIP_ENTRIES, zipFile } from './zip-fixture';

/**
 * p15-chat-zip: a .zip dropped into the chat composer — unpacked in the browser (the site-upload reader), the single top
 * folder stripped, refusals shown before sending, a site uploaded through the chunked site-upload API on send and
 * named in the message; a .zip that is not a site travels as a note only.
 */

configure({ asyncUtilTimeout: 5_000 });

const UP = '00000000-0000-4000-8000-0000000000d1';
const NOW = '2026-10-22T10:00:00.000Z';

const SITE = SITE_ZIP_ENTRIES;

const project = (id: string, myRole: Project['myRole']): Project => ({
  id,
  name: id === 'alpha' ? 'Alpha Site' : id,
  kind: 'repository',
  createdAt: NOW,
  createdBy: null,
  members: 1,
  myRole,
});

describe('planChatZip (in the browser; the master never sees the archive)', () => {
  it('strips the one top folder that holds index.html, skips OS litter, plans a publishable site', async () => {
    const plan = await planChatZip(zipFile('deck.zip', SITE));
    expect(plan.strippedRoot).toBe('deck');
    expect(plan.files.map((f) => f.path)).toEqual(['css/app.css', 'index.html']);
    expect(plan.problems).toEqual([]);
    expect(plan.skipped).toBeGreaterThan(0);
  });

  it('keeps paths as they are when the entries do not share one folder', async () => {
    const plan = await planChatZip(
      zipFile('flat.zip', [
        { name: 'index.html', data: '<h1>x</h1>' },
        { name: 'img/a.svg', data: '<svg/>' },
      ]),
    );
    expect(plan.strippedRoot).toBeNull();
    expect(plan.problems).toEqual([]);
  });

  it('names what is not a site: no index.html at the root, nothing usable, unreadable archive', async () => {
    const docs = await planChatZip(
      zipFile('docs.zip', [
        { name: 'docs/a/index.html', data: '<h1>x</h1>' },
        { name: 'docs/readme.txt', data: 'hi' },
      ]),
    );
    expect(docs.problems).toEqual(['no_index']);
    const none = await planChatZip(zipFile('bin.zip', [{ name: 'tool.exe', data: 'MZ' }]));
    expect(none.problems).toEqual(['no_files']);
    expect(none.refused).toEqual([{ path: 'tool.exe', reason: 'file type not allowed in a site' }]);
    const junk = await planChatZip(new File(['not a zip at all'], 'broken.zip'));
    expect(junk.problems).toEqual(['unreadable']);
    expect(junk.error).toContain('Not a .zip file');
    expect(archiveNote(docs)).toEqual({
      name: 'docs.zip',
      fileCount: 2,
      totalBytes: 12,
      problems: ['no_index'],
    });
  });

  it('refuses unsafe paths file by file and too many files as a whole', async () => {
    const plan = await planChatZip(
      zipFile('mixed.zip', [
        { name: 'index.html', data: '<h1>x</h1>' },
        { name: '../evil.html', data: 'x' },
        { name: '.env', data: 'X=1' },
      ]),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.refused.map((r) => r.path)).toEqual(['../evil.html', '.env']);
    const many = await planChatZip(
      zipFile('many.zip', [
        { name: 'index.html', data: '<h1>x</h1>' },
        ...Array.from({ length: 500 }, (_, i) => ({ name: `p/${String(i)}.txt`, data: 'x' })),
      ]),
    );
    expect(many.problems).toEqual(['too_many_files']);
  });

  it('small helpers: zip detection, display names, projects the person may upload into', () => {
    expect(isZipFile({ name: 'Site.ZIP', type: '' })).toBe(true);
    expect(isZipFile({ name: 'x', type: 'application/x-zip-compressed' })).toBe(true);
    expect(isZipFile({ name: 'a.png', type: 'image/png' })).toBe(false);
    expect(zipDisplayName('C:\\Users\\me\\deck.zip')).toBe('deck.zip');
    expect(zipDisplayName('a\nb.zip')).toBe('a b.zip');
    const list = uploadProjects([
      project('alpha', 'operator'),
      project('beta', 'viewer'),
      project('gamma', 'admin'),
    ]);
    expect(list.map((p) => p.id)).toEqual(['alpha', 'gamma']);
    expect(defaultProject(list, 'gamma')).toBe('gamma');
    expect(defaultProject(list, 'beta')).toBe('alpha');
    expect(defaultProject([], null)).toBeNull();
  });
});

describe('sent messages show their .zip chips', () => {
  it('a site upload with its counts, a note that it is not a site', () => {
    render(
      <I18nProvider>
        <MessageSiteZips
          meta={{
            siteUploads: [{ id: UP, project: 'alpha', label: 'deck.zip', fileCount: 2, totalBytes: 2048 }],
            archives: [{ name: 'notes.zip', fileCount: 3, totalBytes: 10, problems: ['no_index'] }, 'junk'],
          }}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('message-site-upload').textContent).toContain('deck.zip');
    expect(screen.getByTestId('message-site-upload').textContent).toMatch(/2 (files|dosya)/);
    expect(screen.getByTestId('message-archive').textContent).toContain('notes.zip');
  });
});

class SilentEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
