// p12-diyalog Faz 4: Çıktılar (`/outputs`) in the Diyalog language — sites (https only, opened outside the
// console), files, notes and pins as Diyalog rows with a job-thread link, the classic tabs / filters in the URL, the
// classic item drawer (FileViewer previews, notes, pin) reused; flag off keeps the classic Outputs page.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-10-16T08:00:00.000Z';
const empty = { status: 200, body: { items: [], nextCursor: null } };

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

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

function file(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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

const evilSite = {
  ...site,
  key: 'site:pages:evil:preview',
  name: 'evil-site',
  pinned: false,
  jobId: null,
  site: { ...site.site, url: 'javascript:alert(1)' },
};

const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'workspace',
  createdAt: NOW,
  createdBy: null,
  members: 2,
  myRole,
});

function base(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({ status: 200, body: { items: [project('acme', role)] } }),
    'GET /api/outputs/tree': () => ({ status: 200, body: { nodes: [] } }),
    'GET /api/outputs/folders': () => ({ status: 200, body: { items: [] } }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Çıktılar (p12-diyalog Faz 4)', { timeout: 20_000 }, () => {
  it('lists sites and files as rows: https-only site link, pin state, job-thread link, classic tabs', async () => {
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?limit=25': () => ({
          status: 200,
          body: { items: [site, file('report.md'), evilSite], total: 3 },
        }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Çıktılar' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('output-row');
    expect(rows).toHaveLength(3);
    const [s, f, evil] = rows as [HTMLElement, HTMLElement, HTMLElement];
    const open = within(s).getByRole('link', { name: 'Siteyi aç' });
    expect(open.getAttribute('href')).toBe('https://abc.acme-site.pages.dev/');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(s).getByText('Sabit')).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'acme-site: sabitlemeyi kaldır' })).toBeTruthy();
    expect(within(s).getByRole('link', { name: "acme-site: thread'de aç" }).getAttribute('href')).toBe(
      `/jobs/${JOB}`,
    );
    expect(within(f).getByRole('link', { name: "report.md: thread'de aç" })).toBeTruthy();
    // A non-https site URL is dropped by the parser: no link at all; no job → no thread link.
    expect(within(evil).queryByRole('link', { name: 'Siteyi aç' })).toBeNull();
    expect(within(evil).queryByTestId('thread-link')).toBeNull();
    // The classic tab ids (`?tab=site|file|note`) stay.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Tümü',
      'Siteler',
      'Dosyalar',
      'Notlar',
    ]);
    // The classic page is not mounted.
    expect(screen.queryByRole('heading', { level: 1, name: 'Outputs' })).toBeNull();
  });

  it('the Dosyalar tab asks for files (classic URL param)', async () => {
    const r = renderApp({
      path: '/outputs?tab=file',
      initialState: state('owner'),
      routes: base('viewer', {
        'GET /api/outputs?type=file&limit=25': () => ({
          status: 200,
          body: { items: [file('report.md')], total: 1 },
        }),
      }),
    });
    expect(await screen.findAllByTestId('output-row')).toHaveLength(1);
    expect(r.requests.some((q) => q.url === '/api/outputs?type=file&limit=25')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Dosyalar' }).getAttribute('aria-selected')).toBe('true');
    // A viewer cannot pin.
    expect(screen.queryByTestId('row-pin')).toBeNull();
  });

  it('pin on the row sends the classic update; opening a file shows the classic preview drawer', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const md = file('report.md');
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [md], total: 1 } }),
        'PUT /api/outputs/items': (req) => ({
          status: 200,
          body: { ...md, pinned: (req.body as { pinned?: boolean }).pinned ?? false },
        }),
        [`GET /api/outputs/thread?project=acme&key=${encodeURIComponent(String(md.key))}`]: () => ({
          status: 200,
          body: { items: [] },
        }),
        [`GET /api/outputs/item-folders?project=acme&key=${encodeURIComponent(String(md.key))}`]: () => ({
          status: 200,
          body: { items: [] },
        }),
        [`GET /api/jobs/${JOB}/artifacts/ws-report-md?inline=1`]: () => ({
          status: 200,
          raw: '# Rapor\n\n<script>alert(1)</script>',
          headers: { 'content-type': 'text/markdown' },
        }),
      }),
    });
    const row = (await screen.findAllByTestId('output-row'))[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'report.md: sabitle' }));
    await waitFor(() => {
      const put = r.requests.find((q) => q.method === 'PUT');
      expect(put?.body).toEqual({ project: 'acme', key: md.key, pinned: true });
      expect(put?.headers['x-csrf-token']).toBe('csrf-token');
    });
    expect(await within(row).findByRole('button', { name: 'report.md: sabitlemeyi kaldır' })).toBeTruthy();
    // The name opens the classic drawer with its same-origin preview.
    await user.click(within(row).getByRole('button', { name: 'report.md' }));
    const detail = await screen.findByTestId('output-detail');
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/jobs/${JOB}/artifacts/ws-report-md?inline=1`)).toBe(true);
    });
    expect(detail.querySelector('script')).toBeNull();
  });

  // p15-classic-removal: the classic outputs / uptime tests' "watch this site", on the Diyalog drawer.
  it('a site without a monitor: "Bunu izle" asks the master to watch it (POST /uptime/monitors/from-output)', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [site], total: 1 } }),
        [`GET /api/outputs/thread?project=acme&key=${encodeURIComponent(site.key)}`]: () => ({
          status: 200,
          body: { items: [] },
        }),
        [`GET /api/outputs/item-folders?project=acme&key=${encodeURIComponent(site.key)}`]: () => ({
          status: 200,
          body: { items: [] },
        }),
        'POST /api/uptime/monitors/from-output': () => ({ status: 200, body: { created: [], existing: [] } }),
      }),
    });
    const row = (await screen.findAllByTestId('output-row'))[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'acme-site' }));
    const section = await screen.findByTestId('site-uptime-section');
    await user.click(within(section).getByRole('button', { name: 'Bunu izle' }));
    await waitFor(() => {
      expect(
        r.requests.find((q) => q.method === 'POST' && q.url === '/api/uptime/monitors/from-output')?.body,
      ).toEqual({ project: 'acme', key: site.key });
    });
    expect(await within(section).findByTestId('monitor-this-done')).toBeTruthy();
  });
});

// p12-diyalog-w2: the leftovers rebuilt in the Diyalog language — Kartlar / Liste remembered, the keyboard tree,
// breadcrumb, folder header / form / delete, folder and multi-select ZIP, drag to a folder, the item drawer
// (sandboxed HTML, CSV, JSON, notes), related jobs and the new-note form. No classic part is rendered.
const F1 = '11111111-1111-4111-8111-111111111111';

function folderBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: F1,
    scope: 'project',
    project: 'acme',
    parentId: null,
    depth: 1,
    name: 'Raporlar',
    note: '**Haftalık** raporlar',
    tags: ['rapor'],
    pinned: false,
    itemCount: 1,
    childCount: 0,
    createdBy: { id: USER.id, username: 'alex' },
    createdAt: NOW,
    updatedAt: NOW,
    writable: true,
    ancestors: [],
    ...over,
  };
}

const tnode = (n: Record<string, unknown>): Record<string, unknown> => ({
  count: null,
  hasChildren: false,
  folderId: null,
  jobId: null,
  pinned: false,
  ...n,
});

const TREE: Record<string, Handler> = {
  'GET /api/outputs/tree': () => ({
    status: 200,
    body: {
      nodes: [
        tnode({ project: null, path: 'personal', kind: 'personal', label: 'My folders', count: 0 }),
        tnode({ project: 'acme', path: '', kind: 'project', label: 'acme', hasChildren: true }),
      ],
      total: 2,
    },
  }),
  'GET /api/outputs/tree?project=acme': () => ({
    status: 200,
    body: {
      nodes: [
        tnode({
          project: 'acme',
          path: 'folders',
          kind: 'folders',
          label: 'Folders',
          count: 1,
          hasChildren: true,
        }),
        tnode({ project: 'acme', path: 'sites', kind: 'sites', label: 'Sites', count: 0 }),
        tnode({
          project: 'acme',
          path: `job:${JOB}`,
          kind: 'job',
          label: 'Mağazayı kur',
          count: 2,
          hasChildren: true,
          jobId: JOB,
        }),
      ],
      total: 3,
    },
  }),
  [`GET /api/outputs/tree?project=acme&path=job%3A${JOB}`]: () => ({
    status: 200,
    body: {
      nodes: [
        tnode({
          project: 'acme',
          path: `job:${JOB}/site`,
          kind: 'dir',
          label: 'site',
          count: 1,
          jobId: JOB,
        }),
      ],
      total: 1,
    },
  }),
  'GET /api/outputs/tree?project=acme&path=folders': () => ({
    status: 200,
    body: {
      nodes: [
        tnode({
          project: 'acme',
          path: `folder:${F1}`,
          kind: 'folder',
          label: 'Raporlar',
          count: 1,
          folderId: F1,
        }),
      ],
      total: 1,
    },
  }),
};

function catchDownloads(): string[] {
  const saved: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  return saved;
}

const ZIP: Handler = () => ({
  status: 200,
  raw: 'PK',
  headers: {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="outputs-acme.zip"',
  },
});

interface FakeTransfer {
  types: string[];
  effectAllowed: string;
  dropEffect: string;
  setData: (t: string, v: string) => void;
  getData: (t: string) => string;
}

function dataTransfer(): FakeTransfer {
  const data = new Map<string, string>();
  const dt: FakeTransfer = {
    types: [],
    effectAllowed: '',
    dropEffect: '',
    setData(t, v) {
      data.set(t, v);
      dt.types.push(t);
    },
    getData(t) {
      return data.get(t) ?? '';
    },
  };
  return dt;
}

describe('Diyalog Çıktılar leftovers (p12-diyalog-w2)', { timeout: 90_000 }, () => {
  it('Kartlar by default; Liste is remembered under the classic key and used on the next visit', async () => {
    const user = userEvent.setup();
    const routes = base('operator', {
      'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [file('report.md')], total: 1 } }),
    });
    const first = renderApp({ path: '/outputs', initialState: state('owner'), routes });
    expect((await screen.findByTestId('outputs-list')).getAttribute('data-layout')).toBe('grid');
    const layout = screen.getByRole('group', { name: 'Düzen' });
    expect(within(layout).getByRole('button', { name: 'Kartlar' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(layout).getByRole('button', { name: 'Liste' }));
    expect(screen.getByTestId('outputs-list').getAttribute('data-layout')).toBe('list');
    expect(window.localStorage.getItem('outputs.view')).toBe('list');
    first.unmount();
    renderApp({ path: '/outputs', initialState: state('owner'), routes });
    expect((await screen.findByTestId('outputs-list')).getAttribute('data-layout')).toBe('list');
  });

  it('the folder tree: → opens, ↓ moves, Enter scopes to a job, ← goes up, Home / End; breadcrumb; folder ZIP', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const saved = catchDownloads();
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        ...TREE,
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [file('report.md')], total: 1 } }),
        [`GET /api/outputs?project=acme&job=${JOB}&limit=25`]: () => ({
          status: 200,
          body: { items: [file('report.md'), file('site/index.html')], total: 2 },
        }),
        [`GET /api/outputs?project=acme&job=${JOB}&path=site&limit=25`]: () => ({
          status: 200,
          body: { items: [file('site/index.html')], total: 1 },
        }),
        'POST /api/outputs/zip': ZIP,
      }),
    });
    const tree = await screen.findByRole('tree', { name: 'Çıktı klasörleri' });
    // The fixed node labels are Turkish.
    expect(await within(tree).findByRole('treeitem', { name: 'Klasörlerim' })).toBeTruthy();
    const acme = within(tree).getByRole('treeitem', { name: 'acme' });
    acme.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(acme.getAttribute('aria-expanded')).toBe('true');
    });
    const job = await within(tree).findByRole('treeitem', { name: 'Mağazayı kur' });
    expect(job.getAttribute('aria-level')).toBe('2');
    expect(within(tree).getByRole('treeitem', { name: 'Klasörler' })).toBeTruthy();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(job);
    await user.keyboard('{Enter}');
    expect(job.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(screen.getAllByTestId('output-row')).toHaveLength(2);
    });
    const crumbs = screen.getByRole('navigation', { name: 'Konum' });
    expect(within(crumbs).getByText('Mağazayı kur').getAttribute('aria-current')).toBe('page');
    await user.keyboard('{ArrowRight}');
    const dir = await within(tree).findByRole('treeitem', { name: 'site' });
    await user.click(within(dir).getByText('site'));
    await waitFor(() => {
      expect(screen.getAllByTestId('output-row')).toHaveLength(1);
    });
    dir.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(job);
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Klasörlerim');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(dir);
    await user.click(screen.getByRole('button', { name: 'Klasörü ZIP olarak indir' }));
    await waitFor(() => {
      expect(saved).toEqual(['outputs-acme.zip']);
    });
    const zip = r.requests.find((q) => q.method === 'POST' && q.url === '/api/outputs/zip');
    expect(zip?.body).toEqual({ project: 'acme', tree: `job:${JOB}/site` });
    expect(zip?.headers['x-csrf-token']).toBe('csrf-token');
    // p12-diyalog-final: ArrowUp moves to the row above, Space selects it (the classic tree keys, complete).
    dir.focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(job);
    await user.keyboard(' ');
    expect(job.getAttribute('aria-selected')).toBe('true');
    expect(dir.getAttribute('aria-selected')).toBe('false');
  });

  it('multi-select ZIP of one project; a card dragged onto a tree folder is linked', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const saved = catchDownloads();
    const a = file('a.md');
    const b = file('b.md');
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        ...TREE,
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [a, b], total: 2 } }),
        'POST /api/outputs/zip': ZIP,
        [`POST /api/outputs/folders/${F1}/items`]: () => ({
          status: 200,
          body: { added: 1, already: 0, refused: [] },
        }),
      }),
    });
    await screen.findAllByTestId('output-row');
    await user.click(screen.getByRole('checkbox', { name: 'a.md seç' }));
    await user.click(screen.getByRole('checkbox', { name: 'b.md seç' }));
    const bar = screen.getByTestId('selection-bar');
    expect(within(bar).getByText('2')).toBeTruthy();
    await user.click(within(bar).getByRole('button', { name: 'ZIP olarak indir' }));
    await waitFor(() => {
      expect(saved).toEqual(['outputs-acme.zip']);
    });
    expect(r.requests.find((q) => q.url === '/api/outputs/zip')?.body).toEqual({
      project: 'acme',
      keys: [a.key, b.key],
    });
    // Drag a card onto the Raporlar folder in the tree.
    const tree = screen.getByRole('tree');
    const acme = await within(tree).findByRole('treeitem', { name: 'acme' });
    fireEvent.keyDown(acme, { key: 'ArrowRight' });
    const folders = await within(tree).findByRole('treeitem', { name: 'Klasörler' });
    fireEvent.keyDown(folders, { key: 'ArrowRight' });
    const reports = await within(tree).findByRole('treeitem', { name: 'Raporlar' });
    const card = screen.getAllByTestId('output-row')[0] as HTMLElement;
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.types).toContain('application/x-remyral-output');
    const target = reports.querySelector('[data-drop="folder"]') as HTMLElement;
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(await screen.findByText('“Raporlar” klasörüne eklendi.')).toBeTruthy();
    expect(r.requests.find((q) => q.url === `/api/outputs/folders/${F1}/items`)?.body).toEqual({
      project: 'acme',
      keys: [a.key],
    });
  });

  it('a folder page: header with its note, the edit form saves, delete states what stays', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/outputs?folder=${F1}`,
      initialState: state('owner'),
      routes: base('operator', {
        [`GET /api/outputs/folders/${F1}`]: () => ({ status: 200, body: folderBody() }),
        [`GET /api/outputs/tree?project=acme&path=folder%3A${F1}`]: () => ({
          status: 200,
          body: { nodes: [], total: 0 },
        }),
        [`GET /api/outputs?folder=${F1}&limit=25`]: () => ({
          status: 200,
          body: { items: [file('report.md')], total: 1 },
        }),
        [`PATCH /api/outputs/folders/${F1}`]: (req) => ({
          status: 200,
          body: folderBody(req.body as Record<string, unknown>),
        }),
        [`DELETE /api/outputs/folders/${F1}`]: () => ({ status: 200, body: { folders: 1, links: 1 } }),
        [`POST /api/outputs/folders/${F1}/items/remove`]: () => ({ status: 200, body: { removed: 1 } }),
      }),
    });
    const header = await screen.findByTestId('folder-header');
    expect(within(header).getByText('Haftalık').tagName).toBe('STRONG');
    // Inside a writable folder a row can be taken out of it (p15-classic-removal: the classic outputs-folders.test
    // "Remove from folder", asserted here).
    await user.click(await screen.findByRole('button', { name: 'report.md: bu klasörden çıkar' }));
    await waitFor(() => {
      expect(
        r.requests.filter((q) => q.method === 'POST' && q.url === `/api/outputs/folders/${F1}/items/remove`),
      ).toHaveLength(1);
    });
    await user.click(within(header).getByRole('button', { name: 'Düzenle' }));
    const form = await screen.findByRole('dialog', { name: 'Klasörü düzenle' });
    expect(within(form).getByText('Görünürlük: acme projesindeki herkes.')).toBeTruthy();
    const name = within(form).getByLabelText('Ad');
    await user.clear(name);
    await user.type(name, 'Haftalık raporlar');
    await user.click(within(form).getByLabelText('En üste sabitle'));
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'PATCH')?.body).toEqual({
        name: 'Haftalık raporlar',
        note: '**Haftalık** raporlar',
        tags: ['rapor'],
        pinned: true,
      });
    });
    expect(await screen.findByText('“Haftalık raporlar” kaydedildi.')).toBeTruthy();
    await user.click(within(screen.getByTestId('folder-header')).getByRole('button', { name: 'Sil' }));
    const del = await screen.findByRole('dialog', { name: /silinsin mi\?/ });
    expect(within(del).getByText('Öğelerin kendisi Çıktılar’da kalır.')).toBeTruthy();
    await user.click(within(del).getByRole('button', { name: 'Klasörü sil' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'DELETE')).toBe(true);
    });
  });

  it('the drawer: site files only in a sandboxed frame; notes; CSV as a table; JSON as a tree', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const csv = file('data.csv', { mediaType: 'text/csv', preview: 'csv' });
    const json = file('data.json', { mediaType: 'application/json', preview: 'json' });
    const empty200: Handler = () => ({ status: 200, body: { items: [] } });
    const per = (key: unknown): Record<string, Handler> => ({
      [`GET /api/outputs/thread?project=acme&key=${encodeURIComponent(String(key))}`]: empty200,
      [`GET /api/outputs/item-folders?project=acme&key=${encodeURIComponent(String(key))}`]: empty200,
    });
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [site, csv, json], total: 3 } }),
        ...per(site.key),
        ...per(csv.key),
        ...per(json.key),
        [`GET /api/jobs/${JOB}/site-bundle`]: () => ({
          status: 200,
          body: {
            createdAt: NOW,
            directory: 'site',
            flagged: false,
            removed: null,
            files: [
              { path: 'app.js', contentType: 'application/javascript', sizeBytes: 8, view: 'source' },
              { path: 'index.html', contentType: 'text/html', sizeBytes: 40, view: 'html' },
            ],
          },
        }),
        [`GET /api/jobs/${JOB}/artifacts/ws-data-csv?inline=1`]: () => ({
          status: 200,
          raw: 'ad,adet\n"elma, kırmızı",3\n<b>armut</b>,5\n',
          headers: { 'content-type': 'text/csv' },
        }),
        [`GET /api/jobs/${JOB}/artifacts/ws-data-json?inline=1`]: () => ({
          status: 200,
          raw: '{"ad":"vitrin","sayfalar":[1,2]}',
          headers: { 'content-type': 'application/json' },
        }),
        'POST /api/outputs/item-notes': (req) => ({
          status: 200,
          body: {
            id: '99999999-9999-4999-8999-999999999999',
            body: (req.body as { body: string }).body,
            author: { id: USER.id, username: 'alex' },
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'acme-site' }));
    const drawer = await screen.findByTestId('output-drawer');
    expect(within(drawer).getByTestId('open-site').getAttribute('rel')).toBe('noopener noreferrer');
    await user.click(within(drawer).getByText('Site dosyaları'));
    const frame = await within(drawer).findByTestId('html-preview');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('src')).toBe(`/api/jobs/${JOB}/site-bundle/file?path=index.html`);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    await user.type(within(drawer).getByLabelText('Not ekle'), 'Lansmandan önce bak');
    await user.click(within(drawer).getByRole('button', { name: 'Notu ekle' }));
    expect(await within(drawer).findByTestId('item-note')).toBeTruthy();
    expect(r.requests.find((q) => q.url === '/api/outputs/item-notes')?.body).toEqual({
      project: 'acme',
      key: site.key,
      body: 'Lansmandan önce bak',
    });
    await user.click(within(drawer).getByRole('button', { name: 'Kapat' }));
    await user.click(screen.getByRole('button', { name: 'data.csv' }));
    const table = await screen.findByTestId('table-preview');
    expect(within(table).getByText('elma, kırmızı')).toBeTruthy();
    expect(within(table).getByText('<b>armut</b>')).toBeTruthy();
    expect(table.querySelector('b')).toBeNull();
    expect(screen.getAllByText('a'.repeat(64)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Kapat' }));
    await user.click(screen.getByRole('button', { name: 'data.json' }));
    expect(await screen.findByTestId('json-tree')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Metin' }));
    expect(screen.getByTestId('text-preview').textContent).toContain('"sayfalar"');
  });

  it('Yeni not: the Diyalog note form refuses non-https links and creates the note', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: '/outputs',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [], total: 0 } }),
        'POST /api/outputs/notes': (req) => ({
          status: 200,
          body: {
            id: '88888888-8888-4888-8888-888888888888',
            project: 'acme',
            createdAt: NOW,
            updatedAt: NOW,
            author: { id: USER.id, username: 'alex' },
            ...(req.body as Record<string, unknown>),
          },
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Yeni not' }));
    const dialog = await screen.findByTestId('new-note');
    await user.type(within(dialog).getByLabelText('Başlık'), 'Lansman');
    await user.type(within(dialog).getByLabelText('Bağlantılar'), 'http://insecure.example');
    await user.click(within(dialog).getByRole('button', { name: 'Notu oluştur' }));
    expect(within(dialog).getByText('“http://insecure.example” bir https:// bağlantısı değil.')).toBeTruthy();
    expect(r.requests.some((q) => q.url === '/api/outputs/notes')).toBe(false);
    const links = within(dialog).getByLabelText('Bağlantılar');
    await user.clear(links);
    await user.type(links, 'https://vitrin.example');
    await user.click(within(dialog).getByRole('button', { name: 'Notu oluştur' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.url === '/api/outputs/notes')?.body).toEqual({
        project: 'acme',
        title: 'Lansman',
        body: '',
        tags: [],
        links: ['https://vitrin.example'],
        pinned: false,
      });
    });
  });

  it('related jobs: a search in a project offers jobs whose summary matches; one narrows the list', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/outputs?project=acme',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/outputs?project=acme&limit=25': () => ({ status: 200, body: { items: [], total: 0 } }),
        'GET /api/outputs?project=acme&q=rapor&limit=25': () => ({
          status: 200,
          body: { items: [], total: 0 },
        }),
        'GET /api/context/search?project=acme&q=rapor&fallback=keyword&type=job_summary&limit=6': () => ({
          status: 200,
          body: {
            mode: 'semantic',
            fallbackReason: null,
            items: [
              {
                type: 'job_summary',
                id: JOB,
                namespace: 'acme',
                title: 'Rapor',
                snippet: 'Haftalık rapor üretildi',
                version: '1',
                score: 0.9,
              },
            ],
          },
        }),
        [`GET /api/outputs?project=acme&job=${JOB}&limit=25`]: () => ({
          status: 200,
          body: { items: [file('report.md')], total: 1 },
        }),
      }),
    });
    await screen.findByTestId('outputs-empty');
    await user.type(screen.getByLabelText('Ara'), 'rapor{Enter}');
    const related = await screen.findByTestId('outputs-related-jobs');
    expect(within(related).getByText(/anlamca/)).toBeTruthy();
    await user.click(within(related).getByRole('button', { name: /Haftalık rapor üretildi/ }));
    expect(await screen.findAllByTestId('output-row')).toHaveLength(1);
  });
});
