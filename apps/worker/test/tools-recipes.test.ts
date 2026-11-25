import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  defaultRecipe,
  elevatedRecipePrompt,
  findRecipe,
  PLAYWRIGHT_CHROMIUM_REVISION,
  RECIPES,
  recipePlatform,
  type UnprivilegedRecipe,
  unsupportedReason,
} from '../src/tools/recipes.js';

const ONLINE = process.env.REMYRAL_ONLINE_TESTS === '1';

describe('tool recipes shipped in the release', () => {
  it('every unprivileged step is an https artifact with a sha256, a size and an entry inside its directory', () => {
    for (const r of RECIPES) {
      if (r.elevated) {
        expect(r.version).toBe('distro');
        expect(r.apt.length + r.dnf.length).toBeGreaterThan(0);
        // Fixed commands: no placeholders, no pipes to a shell, no downloads.
        for (const c of [...r.apt, ...r.dnf]) expect(c).not.toMatch(/curl|wget|\|\s*sh|\$\{|\$\(/);
        continue;
      }
      for (const [platform, step] of Object.entries(r.platforms)) {
        expect(step.url, `${r.tool} ${platform}`).toMatch(/^https:\/\//);
        expect(step.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(step.size).toBeGreaterThan(1024);
        expect(step.entry.startsWith(`${step.into}/`)).toBe(true);
        expect(step.entry).not.toMatch(/\.\.|^\//);
      }
    }
    const keys = RECIPES.map((r) => `${r.tool}@${r.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the browser is the Chromium revision of the pinned Playwright (1.64.1) for every desktop platform', () => {
    const browser = findRecipe('browser', PLAYWRIGHT_CHROMIUM_REVISION) as UnprivilegedRecipe;
    expect(Object.keys(browser.platforms).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(browser.platforms['win32-x64']?.entry).toBe('chromium-1248/chrome-win64/chrome.exe');
    expect(browser.platforms['darwin-arm64']?.symlinks).toBe(true);
  });

  it('chooses the unprivileged recipe where one exists, the distribution packages on Linux otherwise', () => {
    expect(defaultRecipe('git', 'win32-x64')?.version).toBe('2.56.0.3');
    expect(defaultRecipe('git', 'linux-x64')?.elevated).toBe(true);
    expect(defaultRecipe('python', 'darwin-arm64')).toBeNull();
    expect(defaultRecipe('browser', 'linux-arm64')?.version).toBe(PLAYWRIGHT_CHROMIUM_REVISION);
    expect(recipePlatform('win32', 'ia32')).toBeNull();
    const ffmpeg = findRecipe('ffmpeg', 'distro');
    expect(ffmpeg === null ? 'x' : unsupportedReason(ffmpeg, 'win32-x64')).toMatch(/machine administration/);
    expect(ffmpeg === null ? 'x' : unsupportedReason(ffmpeg, 'linux-arm64')).toBeNull();
  });

  it('p5-live-fixes-2: ffmpeg on Windows is a pinned static build; python gets pip launchers', () => {
    const ff = defaultRecipe('ffmpeg', 'win32-x64');
    if (ff === null || ff.elevated) throw new Error('missing ffmpeg recipe');
    expect(ff.version).toBe('9.0.2');
    const step = ff.platforms['win32-x64'];
    expect(step?.url).toBe(
      'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
    );
    expect(step?.sha256).toBe('60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba');
    expect(step?.entry).toBe('ffmpeg/bin/ffmpeg.exe');
    // Linux keeps the distribution packages.
    expect(defaultRecipe('ffmpeg', 'linux-x64')?.elevated).toBe(true);
    for (const r of RECIPES) {
      if (r.elevated) continue;
      for (const s of Object.values(r.platforms)) {
        for (const shim of s.shims ?? []) {
          expect(shim.path.startsWith(`${s.into}/`)).toBe(true);
          expect(shim.path).not.toMatch(/\.\./);
          // eslint-disable-next-line no-control-regex
          expect(shim.content).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
        }
      }
    }
    const py = defaultRecipe('python', 'win32-x64');
    if (py === null || py.elevated) throw new Error('missing python recipe');
    expect(py.platforms['win32-x64']?.shims?.map((s) => s.path)).toEqual([
      'python/Scripts/pip.cmd',
      'python/Scripts/pip3.cmd',
    ]);
    expect(py.platforms['win32-x64']?.shims?.[0]?.content).toBe(
      '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n',
    );
  });

  it('an elevated recipe becomes a fixed prompt that names exactly its commands', () => {
    const git = findRecipe('git', 'distro');
    if (git === null || !git.elevated) throw new Error('missing');
    const p = elevatedRecipePrompt(git);
    for (const c of [...git.apt, ...git.dnf]) expect(p).toContain(c);
    expect(p).toContain('admin_exec');
    expect(p).toContain('machine_note');
  });

  it.runIf(ONLINE)(
    'online: every pinned archive still has the recorded SHA-256 and size (REMYRAL_ONLINE_TESTS=1)',
    async () => {
      for (const r of RECIPES) {
        if (r.elevated) continue;
        for (const step of Object.values(r.platforms)) {
          const res = await fetch(step.url, { redirect: 'follow' });
          expect(res.ok, step.url).toBe(true);
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            size += chunk.length;
          }
          expect(size, step.url).toBe(step.size);
          expect(hash.digest('hex'), step.url).toBe(step.sha256);
        }
      }
    },
    30 * 60_000,
  );
});
