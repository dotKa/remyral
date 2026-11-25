import { describe, expect, it } from 'vitest';
import { detailsToStore, detailsView } from '../../src/approvals/details.js';
import { adminApprovalDetails } from '../../src/machine-admin/service.js';

/** p17-worker-1-1-1: the approval details of an elevated command — the agent's purpose above the command. */
describe('adminApprovalDetails', () => {
  it('exec: purpose as the agent’s description, the exact command and its shell', () => {
    const d = detailsToStore(
      adminApprovalDetails(
        { kind: 'exec', shell: 'bash', command: 'id -u', cwd: '/root', timeoutSec: 60 },
        'Kök yardımcının çalıştığını denetle',
      ),
    );
    expect(d).toEqual({
      tool: 'admin_exec',
      description: 'Kök yardımcının çalıştığını denetle',
      command: 'id -u',
      shell: 'posix',
      cwd: '/root',
    });
    expect(detailsView(d, '[bash] id -u').headline).toEqual({
      source: 'agent',
      text: 'Kök yardımcının çalıştığını denetle',
    });
  });

  it('files: the path; no purpose (an older worker): nothing is invented', () => {
    expect(
      detailsToStore(
        adminApprovalDetails(
          { kind: 'read_file', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', maxBytes: 10 },
          null,
        ),
      ),
    ).toEqual({ tool: 'admin_read_file', paths: ['C:\\Windows\\System32\\drivers\\etc\\hosts'] });
    const w = detailsToStore(
      adminApprovalDetails(
        { kind: 'write_file', path: '/etc/motd', content: 'aGk=', mode: 'create' },
        'Set the banner',
      ),
    );
    expect(w).toEqual({ tool: 'admin_write_file', description: 'Set the banner', paths: ['/etc/motd'] });
    expect(
      detailsToStore(
        adminApprovalDetails(
          { kind: 'exec', shell: 'powershell', command: 'Get-Service', timeoutSec: 5 },
          null,
        ),
      ),
    ).toEqual({ tool: 'admin_exec', command: 'Get-Service', shell: 'powershell' });
  });
});
