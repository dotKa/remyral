import { configure } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitManifest } from '../src/api/download';
import { localToIso } from '../src/screens/auditFilter';

/** Export body + manifest exactly as the master writes it. */
/** Wraps the stubbed fetch so export URLs answer with raw (non-JSON) bodies. */
// Full-page renders are slow on a loaded CI host; allow more than the 1 s default for findBy*.
configure({ asyncUtilTimeout: 5_000 });

const createObjectURL = vi.fn(() => 'blob:test');

beforeEach(() => {
  createObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

describe('export helpers', () => {
  it('splits body and manifest for JSON Lines and CSV', () => {
    const enc = new TextEncoder();
    const jsonl = splitManifest(enc.encode('{"a":1}\n{"type":"manifest","manifest":{"sha256":"x"}}\n'));
    expect(new TextDecoder().decode(jsonl.body)).toBe('{"a":1}\n');
    expect(jsonl.manifest).toEqual({ sha256: 'x' });
    const csv = splitManifest(enc.encode('"a"\r\n"1"\r\n#manifest,"{""sha256"":""y""}"\r\n'));
    expect(new TextDecoder().decode(csv.body)).toBe('"a"\r\n"1"\r\n');
    expect(csv.manifest).toEqual({ sha256: 'y' });
    expect(() => splitManifest(enc.encode('{"a":1}\n'))).toThrow();
  });

  it('converts datetime-local values to ISO instants', () => {
    expect(localToIso('')).toBeUndefined();
    expect(localToIso('nonsense')).toBeUndefined();
    expect(localToIso('2026-03-01T10:00')).toBe(new Date('2026-03-01T10:00').toISOString());
  });
});
