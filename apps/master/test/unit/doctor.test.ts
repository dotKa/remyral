import { inflateRawSync } from 'node:zlib';
import { Diagnostics, WorkerDoctorReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/doctor/checks.js';
import { configSummary } from '../../src/doctor/config-summary.js';
import { buildSupportMail } from '../../src/doctor/mail.js';
import { diagnosticsToReport } from '../../src/doctor/service.js';
import { buildZip } from '../../src/doctor/zip.js';

/** p16-doctor: the pure parts — the allowlisted config summary, the zip writer, the support mail, the old-worker map. */
describe('doctor (p16-doctor)', () => {
  it('the config summary keeps only allowlisted keys and never a secret, a URL path or a file path', () => {
    const s = configSummary({
      nodeEnv: 'production',
      databaseUrl: 'postgres://u:Secr3t-pw@db/remyral',
      redisUrl: '',
      totpKeyFile: '/run/secrets/totp',
      leaseSigningKeyFile: '/run/secrets/lease',
      releasePublicKeys: ['a', 'b'],
      installers: { publicOrigin: 'https://user:pw@remyral.example.com/install?k=1', publicDownloads: false },
      notifications: {
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls', password: 'pw-123456' },
      },
      telemetry: { serviceName: 'remyral-master', environment: 'https://not-a-name' },
    });
    expect(s).toMatchObject({
      nodeEnv: 'production',
      databaseUrl: true,
      redisUrl: false,
      leaseSigningKeyFile: true,
      releasePublicKeys: 2,
      'installers.publicOrigin': 'https://remyral.example.com',
      'installers.publicDownloads': false,
      'notifications.smtp': true,
      'notifications.smtp.host': 'smtp.example.com',
      'notifications.smtp.port': 465,
      'telemetry.serviceName': 'remyral-master',
    });
    const text = JSON.stringify(s);
    for (const bad of ['Secr3t-pw', '/run/secrets', 'pw-123456', 'user:pw', '?k=1', 'not-a-name'])
      expect(text).not.toContain(bad);
    expect(s).not.toHaveProperty('totpKeyFile');
    expect(configSummary(null)).toEqual({});
  });

  it('the zip writer deflates, names safely and round-trips', () => {
    const big = Buffer.from('x'.repeat(10_000));
    const zip = buildZip([
      { path: 'report.md', data: Buffer.from('# hi\n') },
      { path: 'workers/wrk_a.json', data: big },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.length).toBeLessThan(big.length);
    // Second entry: deflated, and it inflates back.
    const first = 30 + 'report.md'.length + zip.readUInt32LE(18);
    expect(zip.readUInt16LE(first + 8)).toBe(8);
    const size = zip.readUInt32LE(first + 18);
    const nameLen = zip.readUInt16LE(first + 26);
    expect(inflateRawSync(zip.subarray(first + 30 + nameLen, first + 30 + nameLen + size)).equals(big)).toBe(
      true,
    );
    expect(() => buildZip([{ path: '../x', data: Buffer.alloc(1) }])).toThrow();
    expect(() => buildZip([{ path: '/abs', data: Buffer.alloc(1) }])).toThrow();
    expect(() =>
      buildZip([
        { path: 'a', data: Buffer.alloc(1) },
        { path: 'a', data: Buffer.alloc(1) },
      ]),
    ).toThrow();
  });

  it('the support mail: multipart with the zip, Cc, an encoded subject; addresses are checked', () => {
    const m = buildSupportMail({
      from: 'remyral@customer.example',
      to: 'support@vendor.example',
      cc: 'owner@customer.example',
      subject: 'Tanılama raporu\r\nBcc: evil@example.com',
      text: 'Merhaba',
      attachment: { filename: 'remyral-support.zip', data: Buffer.from('PK') },
      reportId: 'r1',
    });
    expect(m).toContain('Cc: owner@customer.example');
    expect(m).toContain('Content-Type: multipart/mixed');
    expect(m).toContain('filename="remyral-support.zip"');
    expect(m).not.toMatch(/^Bcc:/m);
    expect(m).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(() =>
      buildSupportMail({
        from: 'a@b.example',
        to: 'x\r\nBcc: y@z',
        cc: null,
        subject: 's',
        text: 't',
        attachment: null,
        reportId: 'r',
      }),
    ).toThrow();
    const plain = buildSupportMail({
      from: 'a@b.example',
      to: 'c@d.example',
      cc: null,
      subject: 's',
      text: 't',
      attachment: null,
      reportId: 'r',
    });
    expect(plain).toContain('Content-Type: text/plain; charset=utf-8');
    expect(plain).not.toContain('multipart');
  });

  it('an older worker’s diagnostics become doctor findings', () => {
    const d = Diagnostics.parse({
      collectedAt: '2026-10-23T10:00:00.000Z',
      workerVersion: '1.0.60',
      node: { version: '24.11.0', ok: true, requiredMajor: 24 },
      os: { platform: 'linux', release: '6.8', arch: 'x64' },
      uptimeSec: 10,
      memory: { freeBytes: 1, totalBytes: 2 },
      disk: [],
      sandbox: [],
      runtimes: [],
      service: { manager: 'systemd' },
      problems: [{ code: 'disk.low', severity: 'error', message: 'dataDir: 100 MiB free' }],
    });
    const r = WorkerDoctorReport.parse(diagnosticsToReport(d));
    expect(r.summary.error).toBe(1);
    expect(r.findings[0]).toMatchObject({ check: 'worker.disk', code: 'disk_low', severity: 'error' });
  });

  it('versions compare numerically', () => {
    expect(compareVersions('1.0.9', '1.0.74')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.0.74')).toBeGreaterThan(0);
    expect(compareVersions('1.0.74', '1.0.74')).toBe(0);
    expect(compareVersions('dev', '1.0.0')).toBeNull();
  });
});
