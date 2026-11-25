/* global document, window, location -- runs in the browser */
// p19-ide W1: the CSP check's page (apps/web/scripts/csp-codemirror.mjs) — the real cm.ts, mounted like the console
// mounts it, plus a control editor mounted the naive way (in the document, no shadow root), which the CSP must block.
import { EditorView } from '@codemirror/view';
import { mountDiff, mountViewer } from '../../src/diyalog/code/cm.ts';

/** @param {string} id */
const el = (id) => {
  const e = document.getElementById(id);
  if (e === null) throw new Error(id);
  return e;
};
const code = 'export const answer: number = 42;\n// a comment\nconst text = "hello";\n';
const changed =
  'export const answer: number = 43;\n// a comment\nconst text = "hello";\nconst more = true;\n';

if (location.hash === '#control') {
  // Control: CodeMirror in the document itself writes a <style> element — the CSP must refuse it.
  new EditorView({ parent: el('control'), doc: 'control' });
} else {
  mountViewer(el('viewer'), { text: code, path: 'a.ts', label: 'viewer', onSelect: () => undefined });
  mountDiff(el('side'), {
    old: code,
    new: changed,
    path: 'a.ts',
    mode: 'side',
    labels: { old: 'old', new: 'new' },
    onSelect: () => undefined,
  });
  mountDiff(el('inline'), {
    old: code,
    new: changed,
    path: 'a.ts',
    mode: 'inline',
    labels: { old: 'old', new: 'new' },
    onSelect: () => undefined,
  });
}
window.cmReady = true;
