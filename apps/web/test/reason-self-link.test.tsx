// A reason's fix never points back at the page it is shown on; unverified capabilities lead to the runtime policy.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DyReason } from '../src/diyalog/common/notices';

function at(path: string, reason: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <div data-ui="diyalog">
        <DyReason reason={reason} context={{ workerId: 'w1', workerName: 'mac-1' }} />
      </div>
    </MemoryRouter>,
  );
}

describe('reason fixes on the machine page', () => {
  it('drops "open the machine" on that machine’s own pages', () => {
    at('/machines/w1', 'worker_offline: heartbeat lost');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps it elsewhere', () => {
    at('/jobs', 'worker_offline: heartbeat lost');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/machines?worker=w1');
  });

  it('sends unverified capabilities to the runtime policy', () => {
    at('/machines/w1?tab=runtimes', 'degraded: streaming, cancel, approval unverified (allowUnverified)');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings/runtimes');
  });
});
