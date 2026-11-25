import { defaultKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  type LanguageSupport,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * p19-ide W1 (docs/design/p19-ide.md §2.1): the CodeMirror 6 part of the code viewer and the diff reviewer — a lazy
 * chunk (only `/projects/:id/code`, the Kod tab and the job's Değişiklikler reviewer import it).
 *
 * **CSP** (`style-src 'self'`, no nonce): CodeMirror injects its styles through style-mod, which writes a `<style>`
 * element into a document (blocked by the console CSP) but uses a constructable stylesheet (`adoptedStyleSheets`, not
 * an inline style element) in a shadow root. So every editor here mounts inside a shadow root of its host element
 * (`EditorView` / `MergeView` `root`), and inline styles are only set through the CSSOM (`el.style.x`, allowed).
 * Checked in Chromium under the master's exact header by `apps/web/scripts/csp-codemirror.mjs` (no violation, the
 * editor and syntax colours styled). Colours come from the Diyalog tokens (CSS custom properties inherit into the
 * shadow tree), so light / dark follow the console.
 *
 * Everything is read-only: the documents are repository content (untrusted), shown as text.
 */

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface ViewerHandle {
  destroy(): void;
  /** Scrolls to and selects lines `start..end` (clamped to the document). */
  goToLine(start: number, end?: number): void;
  openSearch(): void;
  /** Marks a line range (the `L=` of a link) without moving the selection. */
  mark(range: LineRange | null): void;
}

export interface DiffHandle {
  destroy(): void;
  goToLine(side: 'old' | 'new', line: number): void;
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--dy-violet)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--dy-green)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--dy-faint)',
    fontStyle: 'italic',
  },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--dy-amber-ink)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--dy-teal-ink)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--dy-teal)' },
  { tag: [t.tagName, t.heading], color: 'var(--dy-red-ink)', fontWeight: '600' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--dy-amber-ink)' },
  { tag: [t.link, t.url], textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--dy-red-ink)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--dy-muted)' },
]);

const theme = EditorView.theme({
  '&': {
    color: 'var(--dy-ink)',
    backgroundColor: 'var(--dy-card)',
    fontSize: '0.78125rem',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-dy-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--dy-ink)' },
  '.cm-gutters': {
    backgroundColor: 'var(--dy-sunk)',
    color: 'var(--dy-faint)',
    borderRight: '1px solid var(--dy-line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer', padding: '0 8px 0 10px' }, // i18n-ignore: CSS
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--dy-sunk)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--dy-selection) !important',
  },
  '.cm-refLine': { backgroundColor: 'var(--dy-amber-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--dy-amber-soft)', outline: '1px solid var(--dy-amber)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--dy-amber)' },
  '.cm-panels': { backgroundColor: 'var(--dy-sunk)', color: 'var(--dy-ink)', borderColor: 'var(--dy-line)' },
  '.cm-panel input, .cm-panel button': { fontSize: '0.8125rem' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--dy-card)',
    border: '1px solid var(--dy-line-2)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--dy-card)',
    border: '1px solid var(--dy-line-2)',
    color: 'var(--dy-ink)',
  },
  // Diff colours (both views; they override @codemirror/merge's light / dark defaults with the console's tokens).
  '&.cm-merge-b .cm-changedLine, .cm-insertedLine': { backgroundColor: 'var(--dy-green-soft)' },
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'var(--dy-red-soft)' },
  '&.cm-merge-b .cm-changedText, .cm-insertedLine .cm-changedText': {
    background: 'color-mix(in srgb, var(--dy-green) 30%, transparent)',
  },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--dy-red) 30%, transparent)',
  },
  '.cm-collapsedLines': {
    backgroundColor: 'var(--dy-sunk)',
    color: 'var(--dy-muted)',
    backgroundImage: 'none',
  },
});

/** Shadow root of `host` with a fresh mount point (the CSP note above). */
function shadowMount(host: HTMLElement): { root: ShadowRoot; parent: HTMLElement } {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const parent = host.ownerDocument.createElement('div');
  parent.className = 'cm-host';
  parent.style.height = '100%';
  root.append(parent);
  return { root, parent };
}

// ------------------------------------------------------------------------------------------------ languages

const legacy = (p: Promise<StreamParser<unknown>>): Promise<Extension> =>
  p.then((m) => StreamLanguage.define(m));
const lang = (p: Promise<LanguageSupport>): Promise<Extension> => p;

/** The syntax of a path (loaded on demand: each language is its own small chunk), or null. */
export function loadLanguage(path: string): Promise<Extension> | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.endsWith('.dockerfile'))
    return legacy(import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile));
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return lang(import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })));
    case 'tsx':
      return lang(
        import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
      );
    case 'js':
    case 'mjs':
    case 'cjs':
      return lang(import('@codemirror/lang-javascript').then((m) => m.javascript()));
    case 'jsx':
      return lang(import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })));
    case 'json':
    case 'jsonc':
      return lang(import('@codemirror/lang-json').then((m) => m.json()));
    case 'css':
    case 'scss':
      return lang(import('@codemirror/lang-css').then((m) => m.css()));
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return lang(import('@codemirror/lang-html').then((m) => m.html()));
    case 'md':
    case 'markdown':
      return lang(import('@codemirror/lang-markdown').then((m) => m.markdown()));
    case 'py':
      return lang(import('@codemirror/lang-python').then((m) => m.python()));
    case 'yaml':
    case 'yml':
      return lang(import('@codemirror/lang-yaml').then((m) => m.yaml()));
    case 'sh':
    case 'bash':
    case 'zsh':
      return legacy(import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell));
    case 'go':
      return legacy(import('@codemirror/legacy-modes/mode/go').then((m) => m.go));
    case 'rs':
      return legacy(import('@codemirror/legacy-modes/mode/rust').then((m) => m.rust));
    case 'rb':
      return legacy(import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby));
    case 'swift':
      return legacy(import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift));
    case 'toml':
      return legacy(import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml));
    case 'sql':
      return legacy(import('@codemirror/legacy-modes/mode/sql').then((m) => m.standardSQL));
    case 'ini':
    case 'properties':
    case 'env':
      return legacy(import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties));
    case 'xml':
    case 'svg':
      return legacy(import('@codemirror/legacy-modes/mode/xml').then((m) => m.xml));
    case 'ps1':
      return legacy(import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell));
    case 'c':
    case 'h':
      return legacy(import('@codemirror/legacy-modes/mode/clike').then((m) => m.c));
    case 'cc':
    case 'cpp':
    case 'hpp':
      return legacy(import('@codemirror/legacy-modes/mode/clike').then((m) => m.cpp));
    case 'java':
      return legacy(import('@codemirror/legacy-modes/mode/clike').then((m) => m.java));
    case 'kt':
      return legacy(import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin));
    case 'cs':
      return legacy(import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp));
    default:
      return null;
  }
}

function withLanguage(views: readonly EditorView[], path: string, slot: Compartment): void {
  const load = loadLanguage(path);
  if (load === null) return;
  void load.then(
    (ext) => {
      for (const v of views) if (v.dom.isConnected) v.dispatch({ effects: slot.reconfigure(ext) });
    },
    () => undefined,
  );
}

// ------------------------------------------------------------------------------------------------ shared pieces

/** Lines of the selection (an empty selection = none). */
function selectedLines(state: EditorState): LineRange | null {
  const r = state.selection.main;
  if (r.empty) return null;
  const a = state.doc.lineAt(r.from);
  // A selection that ends at the start of a line does not include that line.
  const endPos = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
  return { start: a.number, end: state.doc.lineAt(Math.max(r.from, endPos)).number };
}

/** A click on a line number selects the whole line (shift extends the selection). */
function clickableGutter(): Extension {
  return lineNumbers({
    domEventHandlers: {
      mousedown(view, line, event) {
        const e = event as MouseEvent;
        const sel = view.state.selection.main;
        const from = e.shiftKey ? Math.min(sel.from, line.from) : line.from;
        const to = e.shiftKey ? Math.max(sel.to, line.to) : line.to;
        view.dispatch({ selection: EditorSelection.range(from, Math.min(to + 1, view.state.doc.length)) });
        view.focus();
        return true;
      },
    },
  });
}

const setMark = StateEffect.define<LineRange | null>();
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let out = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue;
      if (e.value === null) {
        out = Decoration.none;
        continue;
      }
      const b = new RangeSetBuilder<Decoration>();
      const last = Math.min(e.value.end, tr.state.doc.lines);
      for (let n = Math.max(1, e.value.start); n <= last; n++) {
        b.add(tr.state.doc.line(n).from, tr.state.doc.line(n).from, Decoration.line({ class: 'cm-refLine' }));
      }
      out = b.finish();
    }
    return out;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function readOnly(): Extension {
  return [
    EditorState.readOnly.of(true),
    // No on-screen keyboard on a phone tap: the document is read-only.
    EditorView.contentAttributes.of({ inputmode: 'none', 'aria-readonly': 'true' }),
  ];
}

function select(view: EditorView, start: number, end: number): void {
  const doc = view.state.doc;
  const a = doc.line(Math.min(Math.max(1, start), doc.lines));
  const b = doc.line(Math.min(Math.max(start, end), doc.lines));
  view.dispatch({
    selection: EditorSelection.range(a.from, b.to),
    effects: EditorView.scrollIntoView(a.from, { y: 'center' }),
  });
}

// ------------------------------------------------------------------------------------------------ viewer

export function mountViewer(
  host: HTMLElement,
  opts: {
    readonly text: string;
    readonly path: string;
    readonly label: string;
    readonly onSelect: (range: LineRange | null) => void;
    readonly wrap?: boolean;
  },
): ViewerHandle {
  const { root, parent } = shadowMount(host);
  const slot = new Compartment();
  const view = new EditorView({
    root,
    parent,
    state: EditorState.create({
      doc: opts.text,
      extensions: [
        readOnly(),
        clickableGutter(),
        foldGutter(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        bracketMatching(),
        search({ top: true }),
        keymap.of([...searchKeymap, ...defaultKeymap]),
        syntaxHighlighting(highlight),
        markField,
        slot.of([]),
        theme,
        EditorView.contentAttributes.of({ 'aria-label': opts.label }),
        ...(opts.wrap === true ? [EditorView.lineWrapping] : []),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) opts.onSelect(selectedLines(u.state));
        }),
      ],
    }),
  });
  withLanguage([view], opts.path, slot);
  return {
    destroy: () => {
      view.destroy();
    },
    goToLine: (start, end) => {
      select(view, start, end ?? start);
    },
    openSearch: () => {
      view.focus();
      openSearchPanel(view);
    },
    mark: (range) => {
      view.dispatch({ effects: setMark.of(range) });
    },
  };
}

// ------------------------------------------------------------------------------------------------ diff

export function mountDiff(
  host: HTMLElement,
  opts: {
    readonly old: string;
    readonly new: string;
    readonly path: string;
    readonly mode: 'side' | 'inline';
    readonly labels: { readonly old: string; readonly new: string };
    readonly onSelect: (s: { readonly side: 'old' | 'new'; readonly range: LineRange } | null) => void;
  },
): DiffHandle {
  const { root, parent } = shadowMount(host);
  const common = (side: 'old' | 'new', slot: Compartment): Extension => [
    readOnly(),
    clickableGutter(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...searchKeymap, { key: 'Alt-g', run: gotoLine }, ...defaultKeymap]),
    syntaxHighlighting(highlight),
    slot.of([]),
    theme,
    EditorView.contentAttributes.of({ 'aria-label': side === 'old' ? opts.labels.old : opts.labels.new }),
    EditorView.updateListener.of((u) => {
      if (!u.selectionSet) return;
      const range = selectedLines(u.state);
      opts.onSelect(range === null ? null : { side, range });
    }),
  ];
  if (opts.mode === 'inline') {
    const slot = new Compartment();
    const view = new EditorView({
      root,
      parent,
      state: EditorState.create({
        doc: opts.new,
        extensions: [
          common('new', slot),
          unifiedMergeView({
            original: opts.old,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            syntaxHighlightDeletions: true,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
        ],
      }),
    });
    withLanguage([view], opts.path, slot);
    return {
      destroy: () => {
        view.destroy();
      },
      goToLine: (_side, line) => {
        select(view, line, line);
      },
    };
  }
  const slotA = new Compartment();
  const slotB = new Compartment();
  const merge = new MergeView({
    root,
    parent,
    a: { doc: opts.old, extensions: common('old', slotA) },
    b: { doc: opts.new, extensions: common('new', slotB) },
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  withLanguage([merge.a], opts.path, slotA);
  withLanguage([merge.b], opts.path, slotB);
  return {
    destroy: () => {
      merge.destroy();
    },
    goToLine: (side, line) => {
      select(side === 'old' ? merge.a : merge.b, line, line);
    },
  };
}
