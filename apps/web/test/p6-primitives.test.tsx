// p6-ui-refactor Phase A: reason mapping and the shared primitives (roles, keyboard, URL sync).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../src/components/Dialog';
import { describeReason, KNOWN_REASON_CODES, machineHref, parseReason } from '../src/lib/reasons';

function Where(): ReactNode {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function inRouter(ui: ReactNode, path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('reason mapping (lib/reasons.ts)', () => {
  it('parses `code: text`, bare codes and free text', () => {
    expect(parseReason('capability_unverified: capability streaming unverified (ADR-0008)')).toEqual({
      code: 'capability_unverified',
      message: 'capability streaming unverified (ADR-0008)',
    });
    expect(parseReason('tool_missing')).toEqual({ code: 'tool_missing', message: '' });
    expect(parseReason('no capabilities reported yet').code).toBeNull();
    // A plain word counts as a code only when it is mapped.
    expect(parseReason('offline').code).toBe('offline');
    expect(parseReason('hello').code).toBeNull();
  });

  it('maps capability_unverified to the plan sentence with an Allow action', () => {
    const r = describeReason('capability_unverified: capability approval unverified on this OS/version');
    expect(r.known).toBe(true);
    expect(r.sentence).toBe(
      // p17-runtime-verify: the sentence names the fix ("Verify") next to the policy allowance.
      'The runtime is not proven on this machine yet. Prove it with Machine → Runtimes → Verify, or allow it once in Runtime policy.',
    );
    expect(r.action).toEqual({ label: 'Allow', href: '/settings/runtimes' });
    expect(r.raw).toContain('capability approval unverified');
  });

  it('p9-windows-slots-local-login: login_expired after refresh contention gets its own sentence', () => {
    const r = describeReason(
      'login_expired: the subscription login could not be refreshed: another runtime process sharing it was refreshing it at the same time (or exited mid-refresh)',
      { workerId: 'w1', workerName: 'pc', runtime: 'claude-code' },
    );
    expect(r.sentence).toContain('Two Claude Code runs on pc refreshed the shared subscription login');
    expect(r.action?.label).toBe('Log in again');
    expect(describeReason('login_refresh_contention', { runtime: 'codex' }).sentence).toContain(
      'Two Codex runs',
    );
  });

  it('p10-claude-login-health: a lost refresh race says "run it again"; a login wait says the job waits', () => {
    const lost = describeReason(
      'login_refresh_contention: another runtime process of the same subscription login was refreshing it at the same moment, so this run could not start; the login itself was not changed - run the job again',
      { workerId: 'w1', workerName: 'pc', runtime: 'claude-code' },
    );
    expect(lost.sentence).toContain('The login is fine — run the job again.');
    const waiting = describeReason(
      'runtime_not_authenticated: Claude Code needs a login on w1 — waiting (until 2026-10-18T08:30:00.000Z; Machines → <machine> → Runtimes → Log in again)',
      { workerId: 'w1', workerName: 'pc', runtime: 'claude-code' },
    );
    expect(waiting.sentence).toBe(
      'Claude Code needs a login on pc — the job waits and starts by itself once you log in again.',
    );
    expect(waiting.action).toEqual({ label: 'Log in again', href: '/machines?worker=w1&section=remote-ops' });
    expect(
      describeReason('runtime_not_authenticated: codex is not authenticated on the worker', {
        runtime: 'codex',
        workerName: 'pc',
      }).sentence,
    ).toBe('Codex is signed out on pc.');
  });

  it.each([
    [
      'runtime_not_installed',
      'Codex is not installed on mac-1.',
      'Install runtime',
      '/machines?worker=w1&section=remote-ops',
    ],
    [
      'not_authenticated',
      'Codex is signed out on mac-1.',
      'Log in again',
      '/machines?worker=w1&section=remote-ops',
    ],
    [
      'login_expired',
      'The Codex login on mac-1 has expired.',
      'Log in again',
      '/machines?worker=w1&section=remote-ops',
    ],
    [
      'tool_missing',
      'A tool the job needs (such as git) is missing on mac-1.',
      'Install tools',
      '/machines?worker=w1&section=tools',
    ],
    [
      'unconfined_not_opted_in',
      'This project does not allow full machine access.',
      'Open project policy',
      '/projects',
    ],
    [
      'auto_approve_not_allowed',
      'This project does not allow jobs that never ask for approval.',
      'Open project policy',
      '/projects',
    ],
    [
      'no_ready_runtime',
      'mac-1 has no runtime that is ready to run work.',
      'Set up a runtime',
      '/machines?worker=w1&section=remote-ops',
    ],
    [
      'sandbox_profile_unavailable',
      'The sandbox the job needs is not ready on mac-1.',
      'Prepare sandbox',
      '/machines?worker=w1&section=sandbox',
    ],
  ])('%s → sentence and fix', (code, sentence, label, href) => {
    const r = describeReason(`${code}: raw text`, { workerId: 'w1', workerName: 'mac-1', runtime: 'codex' });
    expect(r.sentence).toBe(sentence);
    expect(r.action).toEqual({ label, href });
  });

  it('explains runtime_removed (ADR-0023) without a fix link', () => {
    const r = describeReason('runtime_removed: openhands is no longer a runtime of this platform');
    expect(r.known).toBe(true);
    expect(r.sentence).toBe(
      'OpenHands was removed from the platform (ADR-0023). Choose Claude Code, Codex, Pi or OpenCode.',
    );
    expect(r.action).toBeNull();
  });

  it('falls back to the raw text for unknown codes', () => {
    const r = describeReason('frobnicator_jammed: the frobnicator is jammed');
    expect(r.known).toBe(false);
    expect(r.code).toBe('frobnicator_jammed');
    expect(r.sentence).toBe('frobnicator_jammed: the frobnicator is jammed');
    expect(r.action).toBeNull();
  });

  it('covers every placement reason code of the scheduler', async () => {
    const { REASON_CODES } = await import('../../../packages/scheduler/src/placement');
    for (const code of [...REASON_CODES, 'no_workers']) expect(KNOWN_REASON_CODES).toContain(code);
  });

  it('machineHref builds the machine deep link', () => {
    expect(machineHref('w 1', 'tools')).toBe('/machines?worker=w+1&section=tools');
    expect(machineHref(null)).toBe('/machines');
  });
});

describe('Dialog', () => {
  function Harness(): ReactNode {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </button>
        <Dialog
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title="Rename machine"
          description="Names are shown everywhere."
        >
          <input aria-label="Name" />
        </Dialog>
      </>
    );
  }

  it('is a labelled, described dialog that closes on Escape and the close button, returning focus', async () => {
    const user = userEvent.setup();
    inRouter(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Rename machine' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Names are shown everywhere.').id).toBe(dialog.getAttribute('aria-describedby'));
    // Escape fires the native `cancel` event.
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    });
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  });
});
