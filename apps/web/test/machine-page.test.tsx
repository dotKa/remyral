import { afterEach, describe, expect, it, vi } from 'vitest';
import { machinePath, sectionTab } from '../src/screens/fleet/machineLinks';

const ID = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('machine links (p6-ui-machines)', () => {
  it('maps the old deep-link sections to the machine page tabs', () => {
    expect(sectionTab('remote-ops')).toBe('runtimes');
    expect(sectionTab('sandbox')).toBe('sandbox');
    expect(sectionTab('tools')).toBe('tools');
    expect(sectionTab('machine-admin')).toBe('admin');
    expect(sectionTab('configuration')).toBe('configuration');
    expect(sectionTab(null)).toBe('overview');
    expect(sectionTab('nonsense')).toBe('overview');
    expect(machinePath(ID)).toBe(`/machines/${ID}`);
    expect(machinePath(ID, 'runtimes')).toBe(`/machines/${ID}?tab=runtimes`);
  });
});
