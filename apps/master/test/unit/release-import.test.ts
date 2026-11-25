import { describe, expect, it } from 'vitest';
import { AdminError } from '../../src/cli/admin.js';
import {
  parseReleaseDocument,
  parseRollout,
  readCapped,
  RELEASE_IMPORT_MAX_BYTES,
} from '../../src/releases/import.js';
import { RELEASE_UPLOAD_BODY_LIMIT } from '../../src/releases/uploads.js';

function* chunks(n: number, size: number): Generator<Buffer> {
  for (let i = 0; i < n; i += 1) yield Buffer.alloc(size, 0x20);
}

describe('release-import CLI core (p6-release-import)', () => {
  it('caps stdin at the console upload limit and stops reading beyond it', async () => {
    expect(RELEASE_IMPORT_MAX_BYTES).toBe(RELEASE_UPLOAD_BODY_LIMIT);
    expect((await readCapped(chunks(3, 4), 12)).byteLength).toBe(12);
    await expect(readCapped(chunks(4, 4), 12)).rejects.toThrow(/larger than 12 bytes/);
    const mib = 1024 * 1024;
    let pulled = 0;
    function* counted(): Generator<Buffer> {
      for (let i = 0; i < 100; i += 1) {
        pulled += 1;
        yield Buffer.alloc(mib);
      }
    }
    await expect(readCapped(counted())).rejects.toBeInstanceOf(AdminError);
    expect(pulled).toBe(RELEASE_IMPORT_MAX_BYTES / mib + 1);
    expect(
      (
        await readCapped(
          (function* () {
            yield 'ab';
            yield 'c';
          })(),
        )
      ).toString(),
    ).toBe('abc');
  });

  it('parses --rollout <channel>[:<percent>] like the rollout route (default 100)', () => {
    expect(parseRollout('stable')).toEqual({ channel: 'stable', rolloutPercent: 100 });
    expect(parseRollout('stable:25')).toEqual({ channel: 'stable', rolloutPercent: 25 });
    expect(parseRollout('canary:0')).toEqual({ channel: 'canary', rolloutPercent: 0 });
    for (const bad of [
      '',
      'beta',
      'stable:101',
      'stable:-1',
      'stable:',
      'stable:1.5',
      'Stable',
      'stable:100x',
    ]) {
      expect(() => parseRollout(bad), bad).toThrow(AdminError);
    }
  });

  it('refuses input that is not a release.json document before touching the database', () => {
    expect(() => parseReleaseDocument(Buffer.from('not json'))).toThrow(/not JSON/);
    expect(() => parseReleaseDocument(Buffer.from('{"manifest":"AA=="}'))).toThrow(
      /not a signed release.json/,
    );
    expect(() =>
      parseReleaseDocument(
        Buffer.from(JSON.stringify({ manifest: 'AA==', artifact: 'AA==', signature: { keyId: 'x' } })),
      ),
    ).toThrow(AdminError);
    expect(() => parseReleaseDocument(Buffer.alloc(RELEASE_IMPORT_MAX_BYTES + 1))).toThrow(/larger than/);
  });
});
