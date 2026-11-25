import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor, SecretSet } from '@remyral/observability';
import { SiteBundle } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { collectSiteBundle } from '../src/jobs/site-bundle.js';
import { isWindows, tempDir } from './helpers.js';

/** p6-deploy-pipeline (ADR-0028): the static site bundle a job returns for a Cloudflare Pages ops action. */
describe('collectSiteBundle', () => {
  async function site(): Promise<string> {
    const root = await tempDir('site-');
    await mkdir(join(root, 'dist', 'assets'), { recursive: true });
    await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><h1>Hi</h1>');
    await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(root, 'dist', 'assets', 'app.css'), 'h1{color:red}');
    return root;
  }

  it('packs site files with content types and hashes; skips other types', async () => {
    const root = await site();
    await writeFile(join(root, 'dist', 'notes.exe'), 'MZ');
    await writeFile(join(root, 'dist', '.env'), 'X=1');
    const out = await collectSiteBundle(root, 'dist', new Redactor());
    expect(out.reason).toBeNull();
    expect(out.files).toBe(3);
    const bundle = SiteBundle.parse(JSON.parse(out.bundle?.toString('utf8') ?? '{}'));
    expect(bundle.files.map((f) => [f.path, f.contentType])).toEqual([
      ['assets/app.css', 'text/css'],
      ['assets/app.js', 'application/javascript'],
      ['index.html', 'text/html'],
    ]);
    expect(Buffer.from(bundle.files[2]?.base64 ?? '', 'base64').toString()).toContain('<h1>Hi</h1>');
    expect(out.skipped.map((s) => s.path).sort()).toEqual(['.env', 'notes.exe']);
  });

  it('drops the whole bundle when a file contains an injected secret value or a token pattern', async () => {
    const root = await site();
    const secrets = new SecretSet();
    secrets.add('canary-VALUE-0123456789abcdef', 'MY_TOKEN');
    await writeFile(join(root, 'dist', 'config.json'), '{"k":"canary-VALUE-0123456789abcdef"}');
    const out = await collectSiteBundle(root, 'dist', new Redactor({ secrets }));
    expect(out.bundle).toBeNull();
    expect(out.reason).toContain('config.json');
    const root2 = await site();
    await writeFile(join(root2, 'dist', 'leak.js'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";');
    expect((await collectSiteBundle(root2, 'dist', new Redactor())).bundle).toBeNull();
  });

  it('missing directory, empty directory and too many files return no bundle', async () => {
    const root = await site();
    expect((await collectSiteBundle(root, 'build', new Redactor())).reason).toContain('does not exist');
    await mkdir(join(root, 'empty'));
    expect((await collectSiteBundle(root, 'empty', new Redactor())).reason).toContain('no site files');
  });

  it.skipIf(isWindows)('never follows symbolic links (directory or files)', async () => {
    const root = await site();
    await symlink(join(root, 'dist'), join(root, 'linked'));
    expect((await collectSiteBundle(root, 'linked', new Redactor())).reason).toContain('link');
    await symlink('/etc/hosts', join(root, 'dist', 'hosts.txt'));
    const out = await collectSiteBundle(root, 'dist', new Redactor());
    expect(out.skipped).toContainEqual({ path: 'hosts.txt', reason: 'symbolic link (not followed)' });
    expect(out.bundle?.toString()).not.toContain('localhost');
  });
});
