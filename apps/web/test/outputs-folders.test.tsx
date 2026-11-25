import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dragPayload, folderPath, parseDragPayload, parseFolder } from '../src/api/output-folders';
import { mentionHref } from '../src/screens/chat/MentionPicker';
import { USER } from './helpers';

/**
 * p8-outputs-folders: the Outputs tree (keyboard, lazy levels, breadcrumb, folder ZIP), own folders (deep link,
 * header, remove), drag-and-drop and the keyboard "Add to folder…", the phone drill-down, folder mention links.
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-16T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function folder(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scope: 'project',
    project: 'acme',
    parentId: null,
    depth: 1,
    name,
    note: '',
    tags: [],
    pinned: false,
    itemCount: 1,
    childCount: 0,
    createdBy: { id: USER.id, username: 'alex' },
    createdAt: NOW,
    updatedAt: NOW,
    writable: true,
    ancestors: [],
    ...over,
  };
}

describe('output folder helpers', () => {
  it('parses folders defensively and builds paths; drag payloads accept only Outputs cards', () => {
    const parent = parseFolder(folder(F1, 'Reports'));
    const child = parseFolder(folder(F2, 'Weekly', { parentId: F1, depth: 2 }));
    expect(folderPath(child, [parent, child])).toBe('Reports / Weekly');
    expect(() => parseFolder({ ...folder(F1, 'x'), scope: 'shared' })).toThrow();
    expect(parseDragPayload(dragPayload('acme', `file:${JOB}:ws-a`))).toEqual({
      project: 'acme',
      key: `file:${JOB}:ws-a`,
    });
    expect(parseDragPayload('{"project":"acme","key":"javascript:alert(1)"}')).toBeNull();
    expect(parseDragPayload('not json')).toBeNull();
    expect(mentionHref({ type: 'folder', id: F1 })).toBe(`/outputs?folder=${F1}`);
    expect(mentionHref({ type: 'folder', id: '../x' })).toBeNull();
  });
});
