import {
  act,
  configure,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Project } from '../src/api/directory';
import type { InputUpload } from '../src/api/inputUploads';
import { JobInputBundle } from '../src/diyalog/job/details/InputBundle';
import { ZipInputField } from '../src/diyalog/screens/composer/zip-input';
import { I18nProvider } from '../src/i18n/I18nProvider';
import {
  type InputUploadApi,
  planInputBundle,
  uploadInputBundle,
  withoutPaths,
} from '../src/lib/inputBundle';
import { defaultMode, planChatZip, zipCan } from '../src/screens/chat/chat-zip';
import { useSiteZips } from '../src/screens/chat/useSiteZips';
import { MessageSiteZips, ZipChips } from '../src/screens/chat/ZipAttachments';
import { emptyDraft, validateJob } from '../src/screens/composer/draft';
import { readComposerZip } from '../src/screens/composer/zip-input';
import { fakeFetch, stubCookies } from './helpers';
import { SITE_ZIP_ENTRIES, zipFile } from './zip-fixture';

/**
 * p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060): a .zip as a job's input files in the browser — the
 * planner (the master's rules, NFC names, left-out .git / node_modules / litter), the chip's states (both / site /
 * input, secret findings with "send anyway", leave out refused files), the sent message's chip, the composer field and
 * the job page.
 */

configure({ asyncUtilTimeout: 5_000 });

const IN = '00000000-0000-4000-8000-0000000000e1';
const UP = '00000000-0000-4000-8000-0000000000d1';
const NOW = '2026-10-23T10:00:00.000Z';
const blob = (s: string) => new Blob([s]);
const project: Project = {
  id: 'genel',
  name: 'Genel',
  kind: 'workspace',
  createdAt: NOW,
  createdBy: null,
  members: 1,
  myRole: 'owner',
};
const SOURCE_ZIP = [
  { name: 'proje/', data: '' },
  { name: 'proje/src/main.ts', data: 'export const x = 1;\n' },
  { name: 'proje/README.md', data: '# Proje\n' },
  { name: 'proje/.git/config', data: '[core]' },
  { name: 'proje/node_modules/left/index.js', data: 'x' },
  { name: 'proje/.DS_Store', data: 'x' },
];
const inputUpload = (over: Partial<InputUpload> = {}): InputUpload => ({
  id: IN,
  project: 'genel',
  state: 'ready',
  label: 'proje.zip',
  fileCount: 2,
  totalBytes: 28,
  partSize: 4 * 1024 * 1024,
  partCount: 1,
  received: null,
  keptUntil: NOW,
  secretFindings: [],
  sentWithSecrets: false,
  files: null,
  ...over,
});
const secretsError = () =>
  new ApiError(422, 'input_secrets_found', 'Possible secrets were found.', null, [], {
    findings: [{ path: 'conf/app.env', rule: 'github-token', line: 2 }],
    total: 1,
  });

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('planInputBundle (the master’s rules in the browser)', () => {
  it('normalises names to NFC, leaves out .git / node_modules / litter, strips the one top folder', () => {
    const plan = planInputBundle(
      [
        { path: 'proje/src/main.ts', blob: blob('a') },
        { path: 'proje/docs/café.md', blob: blob('b') },
        { path: 'proje/.git/HEAD', blob: blob('c') },
        { path: 'proje/node_modules/x/i.js', blob: blob('d') },
        { path: 'proje/Thumbs.db', blob: blob('e') },
        { path: 'proje/.env.example', blob: blob('f') },
      ],
      2,
    );
    expect(plan.strippedRoot).toBe('proje');
    expect(plan.files.map((f) => f.path)).toEqual(['.env.example', 'docs/café.md', 'src/main.ts']);
    expect(plan.skipped).toBe(5);
    expect(plan.problems).toEqual([]);
  });

  it('refuses unsafe names and collisions one by one; nothing usable is a problem', () => {
    const plan = planInputBundle([
      { path: 'a/con.txt', blob: blob('x') },
      { path: 'x/A.txt', blob: blob('x') },
      { path: 'x/a.txt', blob: blob('x') },
      { path: 'b/ok.txt', blob: blob('x') },
    ]);
    expect(plan.refused).toEqual([
      { path: 'a/con.txt', reason: 'reserved device name' },
      { path: 'x/a.txt', reason: expect.stringMatching(/listed twice/) as unknown },
    ]);
    expect(planInputBundle([]).problems).toEqual(['no_files']);
    const left = withoutPaths(plan, new Set(['b/ok.txt']));
    expect(left.files.map((f) => f.path)).toEqual(['x/A.txt']);
    expect(left.refused.at(-1)).toEqual({ path: 'b/ok.txt', reason: 'left out' });
  });

  it('a chat .zip: a site can be both, anything else that fits is job input', async () => {
    const site = await planChatZip(zipFile('deck.zip', SITE_ZIP_ENTRIES));
    expect(zipCan(site)).toEqual({ site: true, input: true });
    expect(defaultMode(site)).toBe('both');
    const source = await planChatZip(zipFile('proje.zip', SOURCE_ZIP));
    expect(source.problems.length).toBeGreaterThan(0);
    expect(defaultMode(source)).toBe('input');
    expect(source.input?.files.map((f) => f.path)).toEqual(['README.md', 'src/main.ts']);
    const broken = await planChatZip(new File([new Uint8Array([1, 2, 3])], 'x.zip'));
    expect(defaultMode(broken)).toBeNull();
  });

  it('uploadInputBundle hands "send anyway" to complete', async () => {
    const calls: unknown[] = [];
    const api: InputUploadApi = {
      start: () => Promise.resolve(inputUpload({ state: 'receiving', received: [] })),
      status: () => Promise.resolve(inputUpload({ state: 'receiving', received: [] })),
      putPart: () => Promise.resolve({}),
      complete: (_p, _id, o) => {
        calls.push(o.allowSecrets);
        return Promise.resolve(inputUpload());
      },
    };
    const files = [{ path: 'a.txt', size: 1, blob: blob('a') }];
    const digest = () => Promise.resolve('a'.repeat(64));
    await uploadInputBundle('genel', files, { api, digest });
    await uploadInputBundle('genel', files, { api, digest, allowSecrets: true });
    expect(calls).toEqual([undefined, true]);
  });
});

describe('the chat chip (useSiteZips)', () => {
  function hook(over: { upload?: ReturnType<typeof vi.fn>; uploadInput?: ReturnType<typeof vi.fn> } = {}) {
    const upload = over.upload ?? vi.fn(() => Promise.resolve({ id: UP }));
    const uploadInput = over.uploadInput ?? vi.fn(() => Promise.resolve(inputUpload()));
    const r = renderHook(() =>
      useSiteZips({
        listProjects: () => Promise.resolve([project]),
        upload: upload as never,
        uploadInput: uploadInput as never,
      }),
    );
    return { r, upload, uploadInput };
  }

  it('a site .zip goes both ways by default; narrowed to one, only that one is uploaded', async () => {
    const { r, upload, uploadInput } = hook();
    act(() => {
      r.result.current.add([zipFile('deck.zip', SITE_ZIP_ENTRIES)]);
    });
    await waitFor(() => {
      expect(r.result.current.items[0]?.phase).toBe('ready');
    });
    expect(r.result.current.items[0]?.mode).toBe('both');
    let out: Awaited<ReturnType<typeof r.result.current.prepare>> = null;
    await act(async () => {
      out = await r.result.current.prepare();
    });
    expect(out).toEqual({ siteUploads: [UP], archives: [], inputUploads: [IN] });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadInput).toHaveBeenCalledTimes(1);

    const second = hook();
    act(() => {
      second.r.result.current.add([zipFile('deck.zip', SITE_ZIP_ENTRIES)]);
    });
    await waitFor(() => {
      expect(second.r.result.current.items[0]?.phase).toBe('ready');
    });
    act(() => {
      second.r.result.current.setMode(second.r.result.current.items[0]?.key ?? '', 'input');
    });
    await act(async () => {
      out = await second.r.result.current.prepare();
    });
    expect(out).toEqual({ siteUploads: [], archives: [], inputUploads: [IN] });
    expect(second.upload).not.toHaveBeenCalled();
  });

  it('secret findings stop the send; "send anyway" resumes the same upload with the override', async () => {
    const uploadInput = vi
      .fn()
      .mockImplementationOnce((_p: string, _f: unknown, o: { onStarted?: (id: string) => void }) => {
        o.onStarted?.(IN);
        return Promise.reject(secretsError());
      })
      .mockImplementationOnce(() => Promise.resolve(inputUpload({ sentWithSecrets: true })));
    const { r } = hook({ uploadInput });
    act(() => {
      r.result.current.add([zipFile('proje.zip', SOURCE_ZIP)]);
    });
    await waitFor(() => {
      expect(r.result.current.items[0]?.phase).toBe('ready');
    });
    expect(r.result.current.items[0]?.mode).toBe('input');
    let out: Awaited<ReturnType<typeof r.result.current.prepare>> = null;
    await act(async () => {
      out = await r.result.current.prepare();
    });
    expect(out).toBeNull();
    const item = r.result.current.items[0];
    expect(item?.phase).toBe('secrets');
    expect(item?.findings).toEqual([{ path: 'conf/app.env', rule: 'github-token', line: 2 }]);
    act(() => {
      r.result.current.sendAnyway(item?.key ?? '');
    });
    await act(async () => {
      out = await r.result.current.prepare();
    });
    expect(out).toEqual({ siteUploads: [], archives: [], inputUploads: [IN] });
    expect(uploadInput.mock.calls[1]?.[2]).toMatchObject({ allowSecrets: true, resumeId: IN });
  });

  it('files the master refused (e.g. executables) can be left out, then it starts over', async () => {
    const uploadInput = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject(
          new ApiError(400, 'input_refused', 'The files were refused.', null, [], {
            refused: [{ path: 'README.md', reason: '.exe file (executables are not allowed as job inputs)' }],
          }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(inputUpload()));
    const { r } = hook({ uploadInput });
    act(() => {
      r.result.current.add([zipFile('proje.zip', SOURCE_ZIP)]);
    });
    await waitFor(() => {
      expect(r.result.current.items[0]?.phase).toBe('ready');
    });
    await act(async () => {
      await r.result.current.prepare();
    });
    expect(r.result.current.items[0]?.phase).toBe('failed');
    act(() => {
      r.result.current.leaveOut(r.result.current.items[0]?.key ?? '');
    });
    expect(r.result.current.items[0]?.plan?.input?.files.map((f) => f.path)).toEqual(['src/main.ts']);
    await act(async () => {
      await r.result.current.prepare();
    });
    const files = uploadInput.mock.calls[1]?.[1] as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['src/main.ts']);
  });
});

describe('what the chip and the message show', () => {
  it('a site .zip offers the three choices; findings come with "Send anyway"', async () => {
    const site = await planChatZip(zipFile('deck.zip', SITE_ZIP_ENTRIES));
    const source = await planChatZip(zipFile('proje.zip', SOURCE_ZIP));
    const onMode = vi.fn();
    const onSendAnyway = vi.fn();
    const base = {
      progress: null,
      resumeId: null,
      uploadId: null,
      inputResumeId: null,
      inputUploadId: null,
      allowSecrets: false,
      error: null,
      refusedByMaster: [],
      project: 'genel',
    };
    render(
      <I18nProvider>
        <ZipChips
          items={[
            { ...base, key: 'a', name: 'deck.zip', phase: 'ready', plan: site, mode: 'both', findings: [] },
            {
              ...base,
              key: 'b',
              name: 'proje.zip',
              phase: 'secrets',
              plan: source,
              mode: 'input',
              findings: [{ path: 'conf/app.env', rule: 'github-token', line: 2 }],
            },
          ]}
          projects={[project]}
          projectsFailed={false}
          overflow={0}
          onRemove={vi.fn()}
          onProject={vi.fn()}
          onMode={onMode}
          onSendAnyway={onSendAnyway}
        />
      </I18nProvider>,
    );
    const [both, secret] = screen.getAllByTestId('zip-chip');
    if (both === undefined || secret === undefined) throw new Error('chips');
    expect(within(both).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(within(both).getByRole('radio', { name: /Job input|İş girdisi/ }));
    expect(onMode).toHaveBeenCalledWith('a', 'input');
    expect(within(secret).queryAllByRole('radio')).toHaveLength(0);
    expect(within(secret).getByTestId('zip-secrets').textContent).toMatch(
      /conf\/app\.env (line|satır) 2 \(github-token\)/,
    );
    fireEvent.click(within(secret).getByTestId('zip-send-anyway'));
    expect(onSendAnyway).toHaveBeenCalledWith('b');
    // .git / node_modules / litter left out are counted on the input chip.
    expect(secret.textContent).toMatch(/3 (file|dosya)/);
  });

  it('a sent message names its input bundle and that it went with findings', () => {
    render(
      <I18nProvider>
        <MessageSiteZips
          meta={{
            inputUploads: [
              {
                id: IN,
                project: 'genel',
                label: 'proje.zip',
                fileCount: 12,
                totalBytes: 2048,
                secretFindings: [{ path: 'a', rule: 'r', line: 1 }],
              },
              { id: 7 },
            ],
          }}
        />
      </I18nProvider>,
    );
    const chip = screen.getByTestId('message-input-upload');
    expect(chip.textContent).toContain('proje.zip');
    expect(chip.textContent).toMatch(/12 (files|dosya)/);
    expect(chip.textContent).toMatch(/secret|gizli/);
  });
});

describe('the job composer’s .zip field and the job page', () => {
  it('reads the .zip when picked; findings offer "Send anyway"; schedules refuse a .zip', async () => {
    const zip = await readComposerZip(zipFile('proje.zip', SOURCE_ZIP));
    expect(zip.plan?.files.map((f) => f.path)).toEqual(['README.md', 'src/main.ts']);
    const draft = {
      ...emptyDraft(),
      project: 'genel',
      inputZip: { ...zip, findings: [{ path: 'a.env', rule: 'r', line: 3 }] },
    };
    const set = vi.fn();
    render(
      <I18nProvider>
        <ZipInputField draft={draft} set={set} errors={{}} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('dy-zip-secrets').textContent).toMatch(/a\.env/);
    fireEvent.click(screen.getByTestId('dy-zip-send-anyway'));
    expect(set).toHaveBeenCalledWith({
      inputZip: expect.objectContaining({ allowSecrets: true }) as unknown,
    });
    expect(validateJob({ ...draft, when: 'cron' }, true).inputZip).toMatch(/started now/);
    expect(validateJob(draft, true).inputZip).toBeUndefined();
  });

  it('the job page shows the bundle, whether it is still kept and the findings sent anyway', async () => {
    const f = fakeFetch({
      'GET /api/jobs/j1/input-upload': () => ({
        status: 200,
        body: {
          inputUpload: {
            sourceId: IN,
            label: 'proje.zip',
            fileCount: 2,
            totalBytes: 28,
            attachedAt: NOW,
            pulledAt: NOW,
            kept: true,
            upload: {
              ...inputUpload({
                files: [
                  { path: 'src/main.ts', size: 20 },
                  { path: 'README.md', size: 8 },
                ],
                secretFindings: [{ path: 'conf/app.env', rule: 'github-token', line: 2 }],
                sentWithSecrets: true,
              }),
            },
          },
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <I18nProvider>
        <JobInputBundle jobId="j1" />
      </I18nProvider>,
    );
    const panel = await screen.findByTestId('dy-job-input-bundle');
    expect(panel.textContent).toContain('proje.zip');
    expect(screen.getByTestId('dy-job-input-kept').textContent).toMatch(/Run again|Yeniden çalıştır/);
    expect(panel.textContent).toContain('conf/app.env:2 (github-token)');
    fireEvent.click(within(panel).getByRole('button', { name: /2/ }));
    expect(panel.textContent).toContain('src/main.ts');
  });
});
