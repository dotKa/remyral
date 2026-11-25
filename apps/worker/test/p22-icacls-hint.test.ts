import { describe, expect, it } from 'vitest';
import { ICACLS_DENIED_HINT, icacls } from '../src/sandbox/host/windows-slots.js';

/** p22-harness-gaps: icacls refused (exit 5) names the ownership cause and the administrator's fix. */
describe('icacls failures', () => {
  it('access denied (5) explains the ownership fix; other exits stay as they were', async () => {
    const run = (code: number) => () =>
      Promise.resolve({ code, stdout: '', stderr: 'C:\\d\\a: Access is denied.' });
    await expect(icacls(['C:\\d\\a', '/grant', 'x'], run(5) as never)).rejects.toThrow(
      /does not own this folder.*re-run the Windows installer kit as Administrator.*\/setowner "NT SERVICE\\RemyralWorker"/,
    );
    await expect(icacls(['C:\\d\\a'], run(2) as never)).rejects.toThrow(
      /^icacls C:\\d\\a failed \(2\): C:\\d\\a: Access is denied\.$/,
    );
    expect(ICACLS_DENIED_HINT).not.toContain('\\\\');
  });
});
