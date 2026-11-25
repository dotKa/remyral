import { describe, expect, it } from 'vitest';
import { redactRecord } from '../../src/audit/export.js';
import {
  compareItems,
  countOpen,
  mergeItems,
  type OpsThreadItem,
  refOfLink,
} from '../../src/ops-thread/model.js';

/** p12-diyalog Faz 1: the pure parts of the ops thread (docs/design/p12-diyalog.md §9). */
const A = '0b6c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

function item(id: string, at: string, over: Partial<OpsThreadItem> = {}): OpsThreadItem {
  return { id, type: 'event:alert', at, subject: null, unread: false, event: null, payload: null, ...over };
}

describe('ops thread model', () => {
  it('reads the entity behind a notification link (and nothing else)', () => {
    expect(refOfLink(`/approvals/${A}`)).toEqual({ kind: 'approval', id: A });
    expect(refOfLink(`/deploys/${A.toUpperCase()}`)).toEqual({ kind: 'deploy', id: A });
    expect(refOfLink(`/jobs/${A}?tab=logs`)).toEqual({ kind: 'job', id: A });
    expect(refOfLink(`/jobs/templates/${A}`)).toBeNull();
    expect(refOfLink('/usage?tab=budgets')).toBeNull();
    expect(refOfLink(`/approvals/${A}x`)).toBeNull();
    expect(refOfLink(null)).toBeNull();
  });

  it('orders newest first with the id as a stable tie-break', () => {
    const items = [
      item('n:a', '2026-10-19T10:00:00.000Z'),
      item('n:c', '2026-10-19T11:00:00.000Z'),
      item('n:b', '2026-10-19T10:00:00.000Z'),
    ].sort(compareItems);
    expect(items.map((i) => i.id)).toEqual(['n:c', 'n:b', 'n:a']);
  });

  it('merges a card announced by a notification with the same open card into one item', () => {
    const fromNote = item(`approval:${A}`, '2026-10-19T10:00:01.000Z', {
      type: 'approval:request',
      unread: true,
      event: {
        notificationId: 'n1',
        kind: 'approval.requested',
        severity: 'warning',
        title: 't',
        body: 'b',
        link: `/approvals/${A}`,
      },
      payload: { status: 'pending', v: 1 },
    });
    const open = item(`approval:${A}`, '2026-10-19T10:00:00.000Z', {
      type: 'approval:request',
      payload: { status: 'pending', v: 2 },
    });
    const merged = mergeItems([fromNote, item('n:x', '2026-10-19T09:00:00.000Z')], [open]);
    expect(merged.map((i) => i.id)).toEqual([`approval:${A}`, 'n:x']);
    expect(merged[0]).toMatchObject({
      at: '2026-10-19T10:00:00.000Z',
      unread: true,
      payload: { v: 2 },
      event: { notificationId: 'n1' },
    });
    expect(countOpen([open])).toEqual({ approvals: 1, deploys: 0, merges: 0, failures: 0, limits: 0 });
  });

  it('the defence-in-depth redaction keeps commit ids, branches and PR links readable', () => {
    const v = {
      baseSha: '3f9a2c1e0b9d8c7a6f5e4d3c2b1a0f9e8d7c6b5a',
      branch: 'int/7c1e09ab',
      pullRequest: { number: 218, url: 'https://github.com/acme/app/pull/218' },
      summary: `token ghp_${'Zx9Qw8Er7Ty6'.repeat(3)}`,
    };
    const out = redactRecord({ v }).value.v as typeof v;
    expect(out.baseSha).toBe(v.baseSha);
    expect(out.branch).toBe(v.branch);
    expect(out.pullRequest.url).toBe(v.pullRequest.url);
    expect(out.summary).not.toContain('ghp_');
  });
});
