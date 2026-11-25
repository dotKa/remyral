import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p14-repo-egress: the assistant points to the real setting (Projects → <project> → Policy → Network access) when a
 * job's download got a 403 from the platform proxy, never invents one, and never suggests getting around the proxy.
 */
describe('assistant knowledge of job network access (p14-repo-egress)', () => {
  it('names the real screen, the modes and the floor; no workaround', () => {
    const p = ASSISTANT_SYSTEM_PROMPT;
    expect(p).toContain('26. Network access of jobs');
    expect(p).toContain('Projects → <project> → Policy → Network access');
    expect(p).toContain('Projeler → <proje> → Politika → Ağ erişimi');
    expect(p).toMatch(/"Off" \(default, model APIs only\)/);
    expect(p).toMatch(/LAN, private, loopback and cloud metadata addresses are refused in every mode/);
    expect(p).toMatch(/Never suggest disabling the proxy, setting NO_PROXY/);
    expect(p).toContain('Policy (execution policy, network access)');
    expect(ASSISTANT_TOOLS.list_projects.description).toContain('networkAccess');
  });
});
