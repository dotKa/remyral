import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  createWorkflow,
  getWorkflowDocument,
  saveWorkflowVersion,
  validateWorkflow,
  type WorkflowDocument,
} from '../../../api/workflowDefs';
import { listWorkflowRuns, type WorkflowRunSummary } from '../../../api/workflows';
import { getSession } from '../../../api/auth';
import { getWorkflowCatalog, type WorkflowCatalog } from '../../../api/workflowEngine';
import { useT } from '../../../i18n/I18nProvider';
import type { ApiIssue } from '../../../api/client';
import { cx, toApiError } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { runtimeName } from '../../../lib/reasons';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../icons';
import { runLook } from '../jobs/WorkflowRuns';
import { DyApiError, DyNotice } from '../kit';
import { DyButton, DyButtonLink, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { historyReducer, initHistory } from './history';
import { EdgeInspector, NodeInspector, WorkflowSettings } from './Inspector';
import {
  arrange,
  type ArrangeMode,
  type ArrangeNode,
  directionOf,
  groupSize,
  tidyPositions,
  tidyScoped,
  windowViewport,
} from './layout';
import { ArrangeMenu } from './ArrangeMenu';
import { cardSize } from './nodeLayout';
import { motionOff, tokenMs } from '../../motionKit';
import {
  type AddKind,
  addNode,
  agoIn,
  aiStepBody,
  type AnyNode,
  asDoc,
  cleanDoc,
  connect,
  connectRefusal,
  type ConnectRefusal,
  type Doc,
  type ModelText,
  edgeKey,
  emptyDoc,
  fromPortOf,
  insertNode,
  isAiNode,
  isTypedNode,
  mapIssues,
  MAX_NODES,
  movePositions,
  type PortsOf,
  type Pos,
  positionsOf,
  PREFIX,
  removeElements,
  renameNode,
  roleName,
  toPortOf,
  updateNode,
  V1_PORTS,
  WORKFLOW_NAME,
} from './model';
import { DEFAULT_CONFIG, idPrefix, makePortsOf, nodeTypeText, typeInfo } from './nodeCatalog';
import { Palette, type PaletteChoice } from './Palette';
import { TextPanel } from './TextPanel';
import { TypedNodeInspector } from './TypedInspector';
import { VersionsDialog } from './VersionsDialog';
import { ActivationDialog } from './ActivationDialog';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import WorkflowCanvas, {
  cardInput,
  type CanvasEdge,
  type CanvasNode,
  type CardData,
  type PortView,
} from './WorkflowCanvas';
import { canDefine, runHref } from './WorkflowsScreen';
import { AttachmentDialog, CopyToProjectDialog, isProjectAdmin, ShareDialog } from './SharingDialogs';
import { MetricsTab } from './RunSettings';
import { AiPanel, type AiProposal, AiReview } from './AiPanel';
import { aiChanges, type AiChange, applyAiChanges, previewAiDoc } from './aiDiff';
import { linkWorkflowAiThread, WORKFLOW_AI_MODES, type WorkflowAiMode } from '../../../api/workflowAi';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3): `/workflows/new` and `/workflows/:id` — the workflow editor
 * and viewer. The canvas fills the content area under the page head; the toolbar adds steps (İş adımı, Planlayıcı,
 * Doğrulama, İnceleme, Integrator, Onay kapılı adım), connects, deletes, undoes / redoes, tidies (dagre), fits,
 * toggles the minimap and grid snap, validates with the master (issues on the steps and links), shows the YAML/JSON
 * text and the versions; Kaydet saves a new version, Çalıştır opens the composer's workflow run. Right: the inspector.
 * Read-only for viewers (and archived workflows, older versions); the master enforces `workflows.define` anyway.
 * Lazy chunk (index.tsx): React Flow, dagre and yaml load only here.
 */

type Selection = { readonly kind: 'node' | 'edge'; readonly id: string } | null;

interface Loaded {
  readonly meta: WorkflowDocument | null;
  readonly doc: Doc;
  /** p14: the node catalog when the master runs the new engine (null: the v1 editor, AI steps only). */
  readonly catalog: WorkflowCatalog | null;
  /** p14 14.5: the saved document when `doc` is a chat draft opened on top of it ("Editörde aç"); dirty against it. */
  readonly base?: Doc;
}

/** p14: v2 limit of nodes per workflow (AI steps stay ≤ 50, checked by the master). */
const MAX_NODES_V2 = 200;

/** p14: groups before their bodies (React Flow draws parents first), else document order. */
function depthOf(doc: Doc, n: AnyNode): number {
  let d = 0;
  let p = n.parent;
  while (typeof p === 'string' && d < 10) {
    const id: string = p;
    p = doc.nodes.find((x) => x.id === id)?.parent;
    d++;
  }
  return d;
}

/** p14: the ports a card shows (labels for every port but a lone `in` / `out`). */
function portViews(node: AnyNode, portsOf: PortsOf): NonNullable<CardData['ports']> {
  const ports = portsOf(node);
  const view = (p: { name: string }, lone: string): PortView => ({
    name: p.name,
    label: p.name === lone ? '' : p.name,
    ...(p.name === 'error' ? { error: true } : {}),
  });
  const ins = ports.filter((p) => p.direction === 'in');
  const outs = ports.filter((p) => p.direction === 'out' && p.side !== 'inner');
  const inner = ports.filter((p) => p.direction === 'out' && p.side === 'inner');
  return {
    in: ins.map((p) => view(p, ins.length === 1 ? 'in' : '')),
    out: outs.map((p) => view(p, 'out')),
    ...(inner.length === 0 ? {} : { inner: inner.map((p) => view(p, '')) }),
  };
}

/** p14: the port a node added after `n` is linked from (its first output; a group's `results`). */
function firstOut(n: AnyNode, portsOf: PortsOf): string {
  const outs = portsOf(n).filter((p) => p.direction === 'out' && p.side !== 'inner' && p.name !== 'error');
  return outs[0]?.name ?? 'out';
}

const ADD_ITEMS: readonly { kind: AddKind; icon: IconName }[] = [
  { kind: 'executor', icon: 'jobs' },
  { kind: 'planner', icon: 'grid' },
  { kind: 'verifier', icon: 'checkc' },
  { kind: 'reviewer', icon: 'search' },
  { kind: 'integrator', icon: 'merge' },
  { kind: 'gate', icon: 'shield' },
];

/** The add menu's label of a kind (a gate is an approval-gated work step). */
function addLabel(text: ModelText, kind: AddKind): string {
  return kind === 'gate' ? text.gate : roleName(text, kind);
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const fingerprint = (d: Doc): string => JSON.stringify(cleanDoc(d));

/** Fills in positions for steps that have none (a document from YAML / chat / an older save): tidy for all. */
function withAllPositions(doc: Doc): Doc {
  const pos = positionsOf(doc);
  if (doc.nodes.every((n) => pos[n.id] !== undefined)) return doc;
  const tidy = doc.nodes.some((n) => typeof n.parent === 'string')
    ? tidyScoped(doc.nodes, doc.edges, windowViewport())
    : tidyPositions(
        doc.nodes.map((n) => n.id),
        doc.edges,
        windowViewport(),
      );
  const filled = { ...pos };
  for (const n of doc.nodes) filled[n.id] ??= tidy[n.id] ?? { x: 0, y: 0 };
  return movePositions(doc, filled);
}

// ------------------------------------------------------------------------------------------------ toolbar

function ToolButton(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly shortcut?: string;
  readonly iconClass?: string;
  readonly testId?: string;
  readonly showLabel?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      aria-keyshortcuts={props.shortcut}
      title={props.shortcut === undefined ? props.label : `${props.label} (${props.shortcut})`}
      data-testid={props.testId}
      className={cx(
        'dy-press relative inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[0.8125rem] font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40',
        props.pressed === true
          ? 'bg-dy-ink text-dy-card'
          : 'text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
      )}
    >
      <DyIcon name={props.icon} className={cx('size-4 shrink-0', props.iconClass)} />
      <span className={props.showLabel === true ? undefined : 'sr-only xl:not-sr-only'}>{props.label}</span>
    </button>
  );
}

const Sep = (): ReactNode => <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-dy-line" />;

function AddMenu(props: { readonly disabled: boolean; readonly onAdd: (k: AddKind) => void }): ReactNode {
  const w = useT().workflows;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('mousedown', close);
    };
  }, [open]);
  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        data-testid="toolbar-add"
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[8px] bg-dy-ink px-2.5 text-[0.8125rem] font-bold text-dy-card disabled:opacity-40"
      >
        <DyIcon name="plus" className="size-4" />
        {w.editor.addStep}
      </button>
      {open ? (
        <ul
          role="menu"
          aria-label={w.editor.addStep}
          className="dy-pop absolute top-full left-0 z-20 m-0 mt-1 grid w-56 list-none gap-0.5 rounded-[12px] border border-dy-line bg-dy-card p-1 shadow-dy-pop"
        >
          {ADD_ITEMS.map((i, n) => (
            <li key={i.kind} role="none">
              <button
                type="button"
                role="menuitem"
                autoFocus={n === 0}
                data-testid={`add-${i.kind}`}
                onClick={() => {
                  setOpen(false);
                  props.onAdd(i.kind);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const items = [...(e.currentTarget.closest('ul')?.querySelectorAll('button') ?? [])];
                  const at = items.indexOf(e.currentTarget);
                  items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
                }}
                className="flex min-h-10 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[0.875rem] text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk focus-visible:bg-dy-sunk"
              >
                <DyIcon name={i.icon} className="size-4 text-dy-muted" />
                {addLabel(w.model, i.kind)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Arrow keys move between the toolbar's buttons (WAI-ARIA toolbar). */
function onToolbarKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!(e.target instanceof HTMLButtonElement) || e.target.getAttribute('role') === 'menuitem') return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([role=menuitem])'),
  ].filter((b) => !b.disabled);
  const at = items.indexOf(e.target);
  if (at === -1) return;
  e.preventDefault();
  items[(at + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]?.focus();
}

// ------------------------------------------------------------------------------------------------ runs tab

function RunsTab(props: { readonly project: string; readonly name: string }): ReactNode {
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const now = useNow();
  const messages = useT();
  const w = messages.workflows;
  const t = w.editor.runs;
  const load = useCallback(() => {
    listWorkflowRuns().then(
      (r) => {
        setRuns(r.filter((x) => x.project === props.project && x.name === props.name));
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setRuns((p) => p ?? []);
      },
    );
  }, [props.project, props.name]);
  useEffect(load, [load]);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pt-1 pb-8 sm:px-6">
      <ErrorLine error={error} what={t.title} onRetry={load} />
      <Panel
        title={t.title}
        sub={t.sub}
        count={runs === null ? undefined : String(runs.length)}
        flush
        testId="workflow-runs-tab"
      >
        {runs === null ? (
          <SkeletonRows label={t.loading} />
        ) : runs.length === 0 ? (
          <EmptyLine>{t.none}</EmptyLine>
        ) : (
          <Rows label={t.title}>
            {runs.map((r) => {
              const look = runLook(r.state, messages);
              return (
                <Row
                  key={r.id}
                  testId="workflow-run-row"
                  tone={look.tone}
                  lead={<DyIcon name={look.icon} className="size-[18px]" />}
                  title={
                    <Link
                      to={`/jobs/workflows/${encodeURIComponent(r.id)}`}
                      className="font-dy-mono text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                    >
                      {`${r.id.slice(0, 8)} · v${String(r.version)}`}
                    </Link>
                  }
                  meta={
                    <>
                      <Pill tone={look.tone} icon={look.icon}>
                        {look.label}
                      </Pill>
                      <time dateTime={r.createdAt}>
                        {t.started({ ago: agoIn(w.time, r.createdAt, now) })}
                      </time>
                      {r.endedAt === null ? null : (
                        <time dateTime={r.endedAt}>{t.ended({ ago: agoIn(w.time, r.endedAt, now) })}</time>
                      )}
                    </>
                  }
                />
              );
            })}
          </Rows>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ editor

function Editor(props: {
  readonly loaded: Loaded;
  readonly projects: readonly Project[];
  readonly initialProject: string;
  readonly savedNotice: string | null;
}): ReactNode {
  const { meta, catalog } = props.loaded;
  // p18-multi-project: opened through a project that attached it — the owner's workflow, read-only here.
  const shared = meta?.attachment ?? null;
  const t = useT();
  const w = t.workflows;
  const v2 = catalog?.engineV2 === true;
  const portsOf: PortsOf = useMemo(() => (v2 ? makePortsOf(catalog) : V1_PORTS), [v2, catalog]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const ed = w.editor;
  const refusalText = (r: ConnectRefusal): string =>
    (w.refusals as Record<string, string | undefined>)[r] ?? r;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [h, dispatch] = useReducer(historyReducer, props.loaded.doc, initHistory);
  const doc = h.present;
  const [saved, setSaved] = useState(() => fingerprint(props.loaded.base ?? props.loaded.doc));
  const [project, setProject] = useState(shared?.project ?? meta?.project ?? props.initialProject);
  const [selection, setSelection] = useState<Selection>(null);
  const [checked, setChecked] = useState<{ doc: Doc; issues: readonly ApiIssue[] } | null>(null);
  const [status, setStatus] = useState<string | null>(props.savedNotice);
  const [minimap, setMinimap] = useState(false);
  const [snap, setSnap] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // p14-workflow-engine 14.2: trigger activation (K2).
  const [activationOpen, setActivationOpen] = useState(false);
  // p18-multi-project: "Paylaş" (owner), "Bu projedeki ayarlar" and "Projeye kopyala" (a project that attached it).
  const [shareOpen, setShareOpen] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const stepUp = useStepUp();
  const [sheet, setSheet] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const validate = useSubmit();
  const save = useSubmit();
  // p15-workflow-ai: the AI panel (`?ai=<mode>[&run=<id>]` opens it), its conversation and an edit proposal under review.
  const aiParam = params.get('ai');
  const [aiOpen, setAiOpen] = useState(aiParam !== null);
  const aiMode: WorkflowAiMode | undefined = (WORKFLOW_AI_MODES as readonly string[]).includes(aiParam ?? '')
    ? (aiParam as WorkflowAiMode)
    : undefined;
  const aiThread = useRef<string | null>(null);
  const [review, setReview] = useState<{
    readonly proposed: Doc;
    readonly changes: readonly AiChange[];
    readonly accepted: ReadonlySet<string>;
  } | null>(null);
  const dragging = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  // p17-workflow-canvas: the node selection beyond the inspected node (shift / ⌘-click, box) and an arrangement's
  // in-between positions while it glides.
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [anim, setAnim] = useState<Readonly<Record<string, Pos>> | null>(null);
  const animFrame = useRef<number | null>(null);
  const animDoc = useRef<Doc | null>(null);
  // p17: the reading direction an arrangement chose stays (aligning or dragging a card never turns the ports); undo /
  // redo and a reload read it from the positions again.
  const [dirPin, setDirPin] = useState<'LR' | 'TB' | null>(null);
  const undoRedo = (type: 'undo' | 'redo'): void => {
    setDirPin(null);
    dispatch({ type });
  };

  const isNew = meta === null;
  const old = meta !== null && shared === null && meta.version < meta.latestVersion && restoredFrom === null;
  const allowed = canDefine(props.projects, project);
  // p14 14.2: trigger nodes bound to automations ("Etkinleştir"); manual / chat need none.
  const hasBoundTriggers = doc.nodes.some((x) => {
    const type = (x as { type?: unknown }).type;
    return (
      typeof type === 'string' &&
      type.startsWith('trigger.') &&
      type !== 'trigger.manual' &&
      type !== 'trigger.chat' &&
      type !== 'trigger.error'
    );
  });
  const readOnly = shared !== null || !allowed || (meta?.archived ?? false) || old;
  // p15-workflow-ai: while an AI proposal is reviewed the canvas draws it (with the removed elements) and is locked.
  const preview = useMemo(() => (review === null ? null : previewAiDoc(doc, review.proposed)), [doc, review]);
  const view = useMemo(() => (preview === null ? doc : withAllPositions(preview.doc)), [doc, preview]);
  const locked = readOnly || review !== null;
  const dirty = fingerprint(doc) !== saved;
  const tab = isNew
    ? 'graph'
    : params.get('sekme') === 'calistirmalar'
      ? 'runs'
      : params.get('sekme') === 'metrikler' && v2
        ? 'metrics'
        : 'graph';

  const commit = useCallback((next: Doc, tag?: string) => {
    dispatch({ type: 'commit', doc: next, tag, now: Date.now() });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  // Issues of the last check, on the elements they were found on (ids survive later edits; indices do not).
  const mapped = useMemo(() => (checked === null ? null : mapIssues(checked.doc, checked.issues)), [checked]);
  const issueCount = checked?.issues.length ?? 0;

  const cards = useMemo(() => {
    const diffOf = (id: string): { diff?: 'added' | 'removed' | 'changed'; diffLabel?: string } => {
      const mark = preview?.nodes.get(id);
      return mark === undefined ? {} : { diff: mark, diffLabel: t.workflowAi.diff[mark] };
    };
    // p17: while an arrangement glides, the cards are drawn at their in-between places (the document has the end).
    const pos = anim === null ? positionsOf(view) : { ...positionsOf(view), ...anim };
    // p17: both engines read their direction from the placement (a top → bottom arrangement turns the ports).
    const dir = dirPin ?? directionOf(positionsOf(view), view.edges);
    const defRuntime = typeof view.defaults.runtime === 'string' ? view.defaults.runtime : null;
    const ports = new Map(view.nodes.map((n) => [n.id, v2 ? portViews(n, portsOf) : undefined]));
    const dataOf = (n: AnyNode): CardData => {
      const p = ports.get(n.id);
      if (isTypedNode(n)) {
        return {
          id: n.id,
          type: n.type,
          role: n.type,
          roleLabel: typeof n.label === 'string' ? n.label : (nodeTypeText(w, n.type)?.label ?? n.type),
          runtime: null,
          gate: n.type === 'control.approval',
          dynamic: false,
          planned: false,
          issues: mapped?.byNode.get(n.id)?.length ?? 0,
          state: null,
          editable: !locked,
          dir,
          ...(p === undefined ? {} : { ports: p }),
          ...(typeInfo(catalog, n.type)?.group === true ? { group: true } : {}),
          ...diffOf(n.id),
        };
      }
      const rt = typeof n.runtime === 'string' ? n.runtime : defRuntime;
      return {
        id: n.id,
        role: n.role,
        roleLabel: roleName(w.model, n.role),
        runtime: rt === null ? null : runtimeName(rt),
        gate: n.approval !== undefined,
        dynamic: n.dynamic !== undefined,
        planned: false,
        issues: mapped?.byNode.get(n.id)?.length ?? 0,
        state: null,
        editable: !locked,
        dir,
        ...(p === undefined ? {} : { ports: p }),
        ...diffOf(n.id),
      };
    };
    const data = new Map(view.nodes.map((n) => [n.id, dataOf(n)]));
    // p17: every card as large as its layout needs; a group also as large as its body (sizes bottom-up).
    const own = new Map<string, { w: number; h: number }>();
    const sized = new Map<string, { w: number; h: number }>();
    for (const [id, d] of data) own.set(id, cardSize(cardInput(d, w.canvas.dynamic)));
    const ordered = [...view.nodes].sort((a, b) => depthOf(view, b) - depthOf(view, a));
    for (const n of ordered) {
      const mine = own.get(n.id) ?? { w: 0, h: 0 };
      if (data.get(n.id)?.group === true) {
        const kids = view.nodes.filter((k) => k.parent === n.id);
        const body = groupSize(
          kids.map((k) => pos[k.id] ?? { x: 0, y: 0 }),
          (i) => sized.get(kids[i]?.id ?? '') ?? own.get(kids[i]?.id ?? '') ?? mine,
        );
        sized.set(n.id, { w: Math.max(body.w, mine.w), h: Math.max(body.h, mine.h) });
      } else sized.set(n.id, mine);
    }
    const nodes = [...view.nodes]
      .sort((a, b) => depthOf(view, a) - depthOf(view, b))
      .map((n): CanvasNode => {
        const size = sized.get(n.id);
        return {
          id: n.id,
          position: pos[n.id] ?? { x: 0, y: 0 },
          ...(typeof n.parent === 'string' ? { parent: n.parent } : {}),
          ...(size === undefined ? {} : { size }),
          data: data.get(n.id) ?? dataOf(n),
        };
      });
    return { nodes, sized, own, dir };
  }, [view, mapped, locked, v2, portsOf, catalog, w, preview, t, anim, dirPin]);
  const nodes = cards.nodes;
  // A duplicated link (possible from YAML / chat) is drawn once, marked by its issue.
  const edges: CanvasEdge[] = useMemo(
    () => [
      ...new Map(
        view.edges.map((e) => [
          edgeKey(e),
          {
            id: edgeKey(e),
            from: e.from,
            to: e.to,
            invalid: (mapped?.byEdge.get(edgeKey(e))?.length ?? 0) > 0,
            ...(() => {
              const mark = preview?.edges.get(edgeKey(e));
              return mark === 'added' || mark === 'removed' ? { diff: mark } : {};
            })(),
            ...(v2
              ? {
                  fromPort: fromPortOf(e),
                  toPort: toPortOf(e),
                  ...(fromPortOf(e) === 'out' ? {} : { label: fromPortOf(e) }),
                  ...(fromPortOf(e) === 'error' ? { error: true } : {}),
                }
              : {}),
          },
        ]),
      ).values(),
    ],
    [view, mapped, v2, preview],
  );

  const selectedNode =
    selection?.kind === 'node' ? (doc.nodes.find((n) => n.id === selection.id) ?? null) : null;
  const selectedEdge =
    selection?.kind === 'edge' ? (doc.edges.find((e) => edgeKey(e) === selection.id) ?? null) : null;

  const say = (s: string): void => {
    setStatus(s);
  };

  /** p14: adds from the palette — after the selected node (from its first output), or into a selected group. */
  const addChoice = (c: PaletteChoice): void => {
    if (doc.nodes.length >= MAX_NODES_V2) {
      say(w.editor.tooMany({ n: MAX_NODES_V2 }));
      return;
    }
    const sel = selectedNode;
    const selGroup = sel !== null && isTypedNode(sel) && typeInfo(catalog, sel.type)?.group === true;
    const parent = selGroup ? sel.id : typeof sel?.parent === 'string' ? sel.parent : null;
    const after = sel === null || selGroup ? null : { id: sel.id, port: firstOut(sel, portsOf) };
    const r =
      c.kind === 'ai'
        ? insertNode(doc, aiStepBody(doc, c.add, w.model), PREFIX[c.add], { after, parent, portsOf })
        : insertNode(doc, { type: c.type, config: { ...(DEFAULT_CONFIG[c.type] ?? {}) } }, idPrefix(c.type), {
            after,
            parent,
            portsOf,
          });
    commit(r.doc);
    setSelection({ kind: 'node', id: r.id });
    say(w.editor.added({ id: r.id }));
  };

  const add = (kind: AddKind): void => {
    if (doc.nodes.length >= MAX_NODES) {
      say(ed.tooManySteps({ n: MAX_NODES }));
      return;
    }
    const r = addNode(doc, kind, selectedNode?.id ?? null, undefined, w.model);
    commit(r.doc);
    setSelection({ kind: 'node', id: r.id });
    const role = roleName(w.model, kind === 'gate' ? 'executor' : kind);
    say(
      selectedNode === null
        ? ed.stepAdded({ role, id: r.id })
        : ed.stepAddedAfter({ role, id: r.id, after: selectedNode.id }),
    );
  };

  const tryConnect = (from: string, to: string, fromPort?: string, toPort?: string): void => {
    const r = connect(doc, from, to, { fromPort, toPort }, portsOf);
    if (typeof r === 'string') say(refusalText(r));
    else {
      commit(r);
      say(ed.connected({ from, to }));
    }
  };

  const remove = (nodeIds: readonly string[], edgeIds: readonly string[]): void => {
    if (locked || (nodeIds.length === 0 && edgeIds.length === 0)) return;
    commit(removeElements(doc, nodeIds, edgeIds));
    setSelection(null);
    say(nodeIds.length > 0 ? ed.deleted({ ids: nodeIds.join(', ') }) : ed.edgeDeleted);
  };

  const deleteSelected = (): void => {
    if (selection === null) return;
    if (selection.kind === 'node') remove([selection.id], []);
    else remove([], [selection.id]);
  };

  /** p17: glides the cards from `from` to `to` (one frame at a time; reduced motion / no frames: at once). */
  const glide = (
    from: Readonly<Record<string, Pos>>,
    to: Readonly<Record<string, Pos>>,
    target: Doc,
    done: () => void,
  ): void => {
    if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
    animFrame.current = null;
    const el = canvasRef.current;
    const ms = el === null ? 0 : tokenMs(el, '--dy-m-layout', 280);
    if (el === null || motionOff(el) || typeof requestAnimationFrame !== 'function' || ms <= 0) {
      setAnim(null);
      done();
      return;
    }
    animDoc.current = target;
    const ids = Object.keys(to).filter((id) => from[id] !== undefined);
    const start = performance.now();
    const frame = (): void => {
      // performance.now(), not the frame's timestamp (some engines start that clock elsewhere).
      const k = Math.max(0, Math.min(1, (performance.now() - start) / ms));
      // Ease in-out (a card moving on screen: --dy-m-in-out).
      const e = k < 0.5 ? 8 * k ** 4 : 1 - (-2 * k + 2) ** 4 / 2;
      const at: Record<string, Pos> = {};
      for (const id of ids) {
        const a = from[id] ?? { x: 0, y: 0 };
        const b = to[id] ?? a;
        at[id] = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
      }
      if (k < 1) {
        setAnim(at);
        animFrame.current = requestAnimationFrame(frame);
      } else {
        animFrame.current = null;
        animDoc.current = null;
        setAnim(null);
        done();
      }
    };
    setAnim(from);
    animFrame.current = requestAnimationFrame(frame);
  };
  // Another edit (undo, a drag, a new step) during the glide ends it at once.
  useEffect(() => {
    if (animDoc.current === null || animDoc.current === doc) return;
    if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
    animFrame.current = null;
    animDoc.current = null;
    setAnim(null);
  }, [doc]);
  useEffect(
    () => () => {
      if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
    },
    [],
  );

  const pickedLive = picked.filter((id) => doc.nodes.some((n) => n.id === id));
  // The inspected node is part of the selection; a node selected from outside the canvas resets it.
  const selectedNodes = selectedNode !== null && pickedLive.includes(selectedNode.id) ? pickedLive : [];
  const alignSelection =
    selectedNodes.length > 0 ? selectedNodes : selectedNode === null ? [] : [selectedNode.id];

  /** p17-workflow-canvas: the arrange button's modes (one undo step; the cards glide there). */
  const runArrange = (mode: ArrangeMode): void => {
    const ar = w.arrange;
    if (locked || doc.nodes.length === 0) return;
    if (mode === 'align' && alignSelection.length === 0) {
      say(ar.alignNeedsSelection);
      return;
    }
    const viewport =
      canvasRef.current === null || canvasRef.current.clientWidth === 0
        ? windowViewport()
        : { width: canvasRef.current.clientWidth, height: canvasRef.current.clientHeight };
    const current = positionsOf(doc);
    const arrangeNodes: ArrangeNode[] = doc.nodes.map((n) => {
      const size = cards.sized.get(n.id) ?? cards.own.get(n.id) ?? { w: 232, h: 76 };
      const group = isTypedNode(n) && typeInfo(catalog, n.type)?.group === true;
      const min = cards.own.get(n.id);
      return {
        id: n.id,
        parent: typeof n.parent === 'string' ? n.parent : undefined,
        w: size.w,
        h: size.h,
        ...(group ? { group: true } : {}),
        ...(group && min !== undefined ? { min } : {}),
      };
    });
    const moved = arrange(mode, arrangeNodes, doc.edges, {
      positions: current,
      selection: alignSelection,
      dir: cards.dir,
      viewport,
    });
    if (Object.keys(moved).length === 0) {
      say(mode === 'align' ? ar.nothingToAlign : ar.done({ mode: ar.modes[mode] }));
      return;
    }
    const next = movePositions(doc, moved);
    setDirPin(mode === 'lr' ? 'LR' : mode === 'tb' ? 'TB' : cards.dir);
    commit(next);
    glide(current, { ...current, ...moved }, next, () => {
      if (mode !== 'align') setFit((f) => f + 1);
    });
    say(mode === 'align' ? ar.aligned({ n: Object.keys(moved).length }) : ar.done({ mode: ar.modes[mode] }));
  };

  /**
   * p15-workflow-ai: a validated AI draft. Design: onto the canvas at once as the unsaved working copy (one undo step;
   * the existing positions are kept). Edit: the diff review (nothing changes until changes are accepted).
   */
  const onAiProposal = useCallback(
    (p: AiProposal): void => {
      if (readOnly) return;
      const keepPositions = (next: Doc): Doc =>
        withAllPositions(movePositions(next, { ...positionsOf(next), ...positionsOf(doc) }));
      if (p.mode === 'design') {
        setReview(null);
        commit(keepPositions(p.doc), 'ai');
        setSelection(null);
        setFit((f) => f + 1);
        setChecked(null);
        setStatus(t.workflowAi.proposal.applied);
        return;
      }
      const changes = aiChanges(doc, p.doc);
      if (changes.length === 0) {
        setStatus(t.workflowAi.review.none);
        return;
      }
      setSelection(null);
      setReview({ proposed: p.doc, changes, accepted: new Set(changes.map((c) => c.key)) });
      setStatus(t.workflowAi.review.reviewing);
    },
    [readOnly, doc, commit, t],
  );
  const endReview = (accepted: ReadonlySet<string> | null): void => {
    if (review === null) return;
    if (accepted === null || accepted.size === 0) {
      setReview(null);
      setStatus(accepted === null ? t.workflowAi.review.rejected : t.workflowAi.review.applied({ n: 0 }));
      return;
    }
    commit(withAllPositions(applyAiChanges(doc, review.proposed, accepted)), 'ai');
    setReview(null);
    setChecked(null);
    setStatus(t.workflowAi.review.applied({ n: accepted.size }));
  };
  const onAiThread = useCallback((id: string) => {
    aiThread.current = id;
  }, []);

  const runValidate = (): void => {
    if (project === '') {
      say(ed.validateNeedsProject);
      return;
    }
    const snapshot = doc;
    void validate
      .run(async () => {
        const r = await validateWorkflow(project, cleanDoc(snapshot));
        setChecked({ doc: snapshot, issues: r.issues });
        say(r.ok ? ed.validated : ed.issuesFound({ n: r.issues.length }));
      })
      .then((ok) => {
        if (!ok) say(ed.validateFailed);
      });
  };

  const runSave = (): void => {
    if (readOnly || (!dirty && !isNew)) return;
    if (project === '') {
      say(ed.saveNeedsProject);
      setSelection(null);
      setSheet(true);
      return;
    }
    if (!WORKFLOW_NAME.test(doc.name)) {
      say(ed.saveNeedsName);
      setSelection(null);
      setSheet(true);
      return;
    }
    const snapshot = doc;
    void save.run(async () => {
      try {
        const body = cleanDoc(snapshot);
        // p14 14.2: a version that adds or changes privileged nodes needs a fresh step-up (asked on demand).
        const r = await stepUp.run(
          () =>
            meta === null
              ? createWorkflow(project, body)
              : saveWorkflowVersion(meta.latestId, body, meta.latestVersion),
          t.workflows.editor.stepUpSave,
        );
        setSaved(fingerprint(snapshot));
        // p15-workflow-ai: the panel's conversation of a new workflow now belongs to it (best effort).
        if (meta === null && aiThread.current !== null) {
          await linkWorkflowAiThread(aiThread.current, { project, workflowId: r.id }).catch(() => undefined);
        }
        void navigate(`/workflows/${encodeURIComponent(r.id)}`, {
          replace: true,
          // p18-multi-project: how many attaching projects moved to the version and how many wait for their admin.
          state: { saved: r.version, ...(r.attachments === undefined ? {} : { sharing: r.attachments }) },
        });
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        if (err instanceof ApiError && err.issues.length > 0) {
          setChecked({ doc: snapshot, issues: err.issues });
        }
        throw err;
      }
    });
  };

  // `?dogrula=1` (a link from a chat card or an error): validate once on open.
  const autoValidated = useRef(false);
  useEffect(() => {
    if (autoValidated.current || params.get('dogrula') !== '1' || doc.nodes.length === 0) return;
    autoValidated.current = true;
    runValidate();
  });

  const onSelectNode = (id: string | null): void => {
    if (id !== null && connectFrom !== undefined) {
      if (connectFrom === null) {
        setConnectFrom(id);
        say(ed.pickTarget({ id }));
      } else {
        tryConnect(connectFrom, id);
        setConnectFrom(undefined);
      }
      return;
    }
    setSelection(id === null ? null : { kind: 'node', id });
    if (id !== null) setSheet(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && connectFrom !== undefined) {
      setConnectFrom(undefined);
      say(ed.connectCancelled);
      return;
    }
    if (e.key === '/' && v2 && !readOnly && !isTyping(e.target)) {
      e.preventDefault();
      setPaletteOpen(true);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      runSave();
      return;
    }
    if (isTyping(e.target)) return;
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoRedo('undo');
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      undoRedo('redo');
    }
  };

  const nodeIssues = selectedNode === null ? [] : (mapped?.byNode.get(selectedNode.id) ?? []);
  const inspectorTitle =
    selectedNode !== null ? (
      <span className="font-dy-mono">{selectedNode.id}</span>
    ) : selectedEdge !== null ? (
      ed.edge
    ) : (
      ed.settings
    );

  const title = isNew ? (doc.name === '' ? ed.newTitle : doc.name) : meta.name;
  const versionText = meta === null ? null : `v${String(meta.version)}`;

  return (
    <ScreenFrame
      title={title}
      layout="canvas"
      back={{ to: '/workflows', label: ed.back }}
      testId="dy-workflow-editor"
      facts={
        <>
          {project === '' ? null : (
            <Pill tone="neutral" icon="folder">
              {project}
            </Pill>
          )}
          {versionText === null ? (
            <Pill tone="teal">{ed.newPill}</Pill>
          ) : (
            <Pill tone="neutral">{versionText}</Pill>
          )}
          {dirty && !readOnly ? (
            <span data-testid="workflow-dirty">
              <Pill tone="amber" icon="pen">
                {ed.dirty}
              </Pill>
            </span>
          ) : null}
          {meta?.archived === true ? <Pill tone="neutral">{ed.archived}</Pill> : null}
          {shared === null || meta === null ? null : (
            <span data-testid="workflow-shared">
              <Pill tone="teal" icon="branch">
                {t.workflowSharing.editor.sharedFrom({ owner: meta.project })}
              </Pill>
            </span>
          )}
          {shared?.pendingVersion == null ? null : (
            <Pill tone="amber">{t.workflowSharing.editor.pending({ version: shared.pendingVersion })}</Pill>
          )}
          {readOnly ? (
            <span data-testid="workflow-readonly">
              <Pill tone="neutral" icon="key">
                {ed.readOnly}
              </Pill>
            </span>
          ) : null}
          {issueCount > 0 ? (
            <Pill tone="red" icon="xc">
              {ed.issueCount({ n: issueCount })}
            </Pill>
          ) : checked !== null && !validate.busy ? (
            <Pill tone="green" icon="checkc">
              {ed.valid}
            </Pill>
          ) : null}
        </>
      }
      actions={
        <>
          {meta !== null && shared !== null ? (
            <DyButton
              icon="gear"
              data-testid="workflow-attachment-open"
              onClick={() => {
                setAttachmentOpen(true);
              }}
            >
              {t.workflowSharing.list.settings}
            </DyButton>
          ) : meta !== null ? (
            <DyButton
              icon="branch"
              data-testid="workflow-share-open"
              onClick={() => {
                setShareOpen(true);
              }}
            >
              {t.workflowSharing.share.open}
            </DyButton>
          ) : null}
          {meta !== null && !meta.archived && allowed && (shared === null || shared.state === 'enabled') ? (
            <DyButtonLink
              to={
                shared === null
                  ? runHref({ id: meta.latestId, project: meta.project })
                  : runHref({ id: meta.id, project: shared.project })
              }
              icon="send"
              aria-label={dirty ? ed.runDirty : ed.run}
            >
              {ed.run}
            </DyButtonLink>
          ) : null}
          {readOnly ? null : (
            <DyButton
              variant="primary"
              icon="check"
              busy={save.busy}
              disabled={(!dirty && !isNew) || save.blocked}
              aria-keyshortcuts="Control+S Meta+S"
              data-testid="workflow-save"
              onClick={runSave}
            >
              {isNew ? ed.save : ed.saveVersion}
            </DyButton>
          )}
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-2 sm:px-6">
          {isNew ? null : (
            <div
              role="tablist"
              aria-label={ed.workflow}
              className="flex gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
            >
              {(
                [
                  ['graph', ed.tabGraph],
                  ['runs', ed.tabRuns],
                  // p14 14.4: runs by state, node durations and failures (the new engine only).
                  ...(v2 ? ([['metrics', t.workflows.metrics.tab]] as const) : []),
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (id === 'runs') next.set('sekme', 'calistirmalar');
                    else if (id === 'metrics') next.set('sekme', 'metrikler');
                    else next.delete('sekme');
                    setParams(next, { replace: true });
                  }}
                  className={cx(
                    'inline-flex min-h-8 items-center rounded-[7px] px-3 text-[0.84375rem] font-medium',
                    tab === id
                      ? 'bg-dy-card text-dy-ink shadow-[0_1px_2px_rgb(24_32_49/0.1)]'
                      : 'text-dy-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <DyApiError error={save.error ?? validate.error} retryLeft={save.retryLeft} />
          </div>
        </div>
        {old ? (
          <div className="shrink-0 px-3 pb-2 sm:px-6">
            <DyNotice
              tone="amber"
              testId="workflow-old-version"
              action={
                <span className="flex flex-wrap gap-2">
                  <DyButtonLink to={`/workflows/${encodeURIComponent(meta.latestId)}`}>
                    {ed.goLatest({ version: meta.latestVersion })}
                  </DyButtonLink>
                  {allowed && !meta.archived ? (
                    <DyButton
                      variant="primary"
                      onClick={() => {
                        setRestoredFrom(meta.version);
                        say(ed.restoredOld({ version: meta.version, next: meta.latestVersion + 1 }));
                      }}
                    >
                      {ed.continueFromThis}
                    </DyButton>
                  ) : null}
                </span>
              }
            >
              {ed.oldVersion({ version: meta.version, latest: meta.latestVersion })}
            </DyNotice>
          </div>
        ) : null}
        {tab === 'runs' && meta !== null ? (
          <RunsTab project={shared?.project ?? meta.project} name={meta.name} />
        ) : tab === 'metrics' && meta !== null ? (
          <MetricsTab
            definitionId={shared === null ? meta.latestId : meta.id}
            {...(shared === null ? {} : { project: shared.project })}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col border-t border-dy-line">
            <div
              role="toolbar"
              aria-label={ed.toolbar}
              aria-controls="workflow-canvas"
              onKeyDown={onToolbarKey}
              className="relative z-[7] flex shrink-0 items-center gap-1 border-b border-dy-line bg-dy-card px-2 py-1.5 sm:px-4"
              data-testid="workflow-toolbar"
            >
              {v2 ? (
                <Palette
                  catalog={catalog}
                  projectRole={props.projects.find((p) => p.id === project)?.myRole ?? null}
                  disabled={readOnly}
                  open={paletteOpen}
                  onOpen={setPaletteOpen}
                  onAdd={addChoice}
                />
              ) : (
                <AddMenu disabled={readOnly} onAdd={add} />
              )}
              {/* The add menu stays outside the scrolling part (its popover must not be clipped). */}
              <div className="dy-noscrollbar relative flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                <ToolButton
                  icon="merge"
                  label={ed.connect}
                  pressed={connectFrom !== undefined}
                  disabled={readOnly || doc.nodes.length < 2}
                  testId="toolbar-connect"
                  onClick={() => {
                    if (connectFrom !== undefined) {
                      setConnectFrom(undefined);
                      say(ed.connectCancelled);
                    } else {
                      setConnectFrom(selectedNode?.id ?? null);
                      say(selectedNode === null ? ed.pickFirst : ed.pickNext({ id: selectedNode.id }));
                    }
                  }}
                />
                <ToolButton
                  icon="trash"
                  label={ed.delete}
                  disabled={readOnly || selection === null}
                  shortcut="Delete"
                  testId="toolbar-delete"
                  onClick={deleteSelected}
                />
                <Sep />
                <ToolButton
                  icon="back"
                  label={ed.undo}
                  disabled={readOnly || h.past.length === 0}
                  shortcut="Control+Z"
                  testId="toolbar-undo"
                  onClick={() => {
                    undoRedo('undo');
                  }}
                />
                <ToolButton
                  icon="back"
                  iconClass="-scale-x-100"
                  label={ed.redo}
                  disabled={readOnly || h.future.length === 0}
                  shortcut="Control+Shift+Z"
                  testId="toolbar-redo"
                  onClick={() => {
                    undoRedo('redo');
                  }}
                />
                <Sep />
                <ArrangeMenu
                  disabled={locked || doc.nodes.length === 0}
                  canAlign={alignSelection.length > 0}
                  onArrange={runArrange}
                />
                <ToolButton
                  icon="search"
                  label={ed.fit}
                  disabled={doc.nodes.length === 0}
                  testId="toolbar-fit"
                  onClick={() => {
                    setFit((f) => f + 1);
                  }}
                />
                <ToolButton
                  icon="globe"
                  label={ed.minimap}
                  pressed={minimap}
                  testId="toolbar-minimap"
                  onClick={() => {
                    setMinimap((m) => !m);
                  }}
                />
                <ToolButton
                  icon="grid"
                  label={ed.snap}
                  pressed={snap}
                  testId="toolbar-snap"
                  onClick={() => {
                    setSnap((s) => !s);
                  }}
                />
                <Sep />
                <ToolButton
                  icon="checkc"
                  label={validate.busy ? ed.validating : ed.validate}
                  disabled={validate.busy || doc.nodes.length === 0}
                  testId="toolbar-validate"
                  onClick={runValidate}
                />
                {shared === null ? (
                  <ToolButton
                    icon="brain"
                    label={t.workflowAi.open}
                    pressed={aiOpen}
                    testId="toolbar-ai"
                    showLabel
                    onClick={() => {
                      setAiOpen((o) => !o);
                    }}
                  />
                ) : null}
                <ToolButton
                  icon="file"
                  label={ed.textToggle}
                  pressed={textOpen}
                  testId="toolbar-text"
                  onClick={() => {
                    setTextOpen((t) => !t);
                  }}
                />
                {meta === null || !hasBoundTriggers ? null : (
                  <ToolButton
                    icon="send"
                    label={t.workflows.activation.open}
                    testId="toolbar-activation"
                    onClick={() => {
                      setActivationOpen(true);
                    }}
                  />
                )}
                {meta === null ? null : (
                  <ToolButton
                    icon="clock"
                    label={ed.versions}
                    testId="toolbar-versions"
                    onClick={() => {
                      setVersionsOpen(true);
                    }}
                  />
                )}
                <ToolButton
                  icon="gear"
                  label={ed.settings}
                  pressed={selection === null && sheet}
                  testId="toolbar-settings"
                  onClick={() => {
                    setSelection(null);
                    setSheet(true);
                  }}
                />
              </div>
            </div>
            <p
              role="status"
              aria-live="polite"
              data-testid="workflow-status"
              className="m-0 min-h-0 shrink-0 truncate px-3 text-[0.78125rem] text-dy-muted empty:hidden sm:px-6"
            >
              {status ?? ''}
            </p>
            <div className="relative flex min-h-0 flex-1">
              <div
                className="relative min-w-0 flex-1"
                ref={canvasRef}
                id="workflow-canvas"
                data-testid="workflow-canvas"
                data-edges={edges.map((e) => e.id).join(' ')}
                data-invalid-edges={edges
                  .filter((e) => e.invalid === true)
                  .map((e) => e.id)
                  .join(' ')}
              >
                <WorkflowCanvas
                  label={ed.graphLabel({ title })}
                  nodes={nodes}
                  edges={edges}
                  selectedNode={selectedNode?.id ?? connectFrom ?? null}
                  selectedNodes={selectedNodes}
                  onSelectNodes={setPicked}
                  selectedEdge={selectedEdge === null ? null : edgeKey(selectedEdge)}
                  editable={!locked}
                  snap={snap}
                  minimap={minimap}
                  fitSignal={fit}
                  onSelectNode={onSelectNode}
                  onSelectEdge={(id) => {
                    setSelection(id === null ? null : { kind: 'edge', id });
                    if (id !== null) setSheet(true);
                  }}
                  onMove={(moved, done) => {
                    if (locked) return;
                    const next = movePositions(doc, moved);
                    if (!dragging.current) {
                      dragging.current = true;
                      dispatch({ type: 'commit', doc: next, now: Date.now() });
                    } else dispatch({ type: 'replace', doc: next });
                    if (done) dragging.current = false;
                  }}
                  canConnect={(from, to, fromPort, toPort) =>
                    connectRefusal(doc, from, to, { fromPort, toPort }, portsOf) === null
                  }
                  onConnect={tryConnect}
                  onDelete={remove}
                  className="h-full w-full"
                />
                {doc.nodes.length === 0 ? (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
                    <div
                      className="pointer-events-auto grid max-w-sm gap-3 rounded-[14px] border border-dy-line bg-dy-card p-5 text-center shadow-dy"
                      data-testid="workflow-empty"
                    >
                      <p className="m-0 text-[1rem] font-bold">
                        {readOnly ? ed.emptyReadOnly : ed.emptyTitle}
                      </p>
                      {readOnly ? null : (
                        <>
                          <p className="m-0 text-[0.875rem] text-dy-muted">{ed.emptyHint}</p>
                          <div className="flex flex-wrap justify-center gap-2">
                            <DyButton
                              icon="grid"
                              onClick={() => {
                                add('planner');
                              }}
                            >
                              {w.model.roles.planner}
                            </DyButton>
                            <DyButton
                              variant="primary"
                              icon="jobs"
                              onClick={() => {
                                add('executor');
                              }}
                            >
                              {w.model.roles.executor}
                            </DyButton>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              {aiOpen && shared === null ? (
                <aside
                  aria-label={t.workflowAi.title}
                  className="absolute inset-0 z-[6] flex flex-col bg-dy-card lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-dy-line"
                >
                  {review === null ? null : (
                    <AiReview
                      changes={review.changes}
                      accepted={review.accepted}
                      onToggle={(key) => {
                        const next = new Set(review.accepted);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        setReview({ ...review, accepted: next });
                      }}
                      onAcceptAll={() => {
                        endReview(new Set(review.changes.map((c) => c.key)));
                      }}
                      onRejectAll={() => {
                        endReview(null);
                      }}
                      onApply={() => {
                        endReview(review.accepted);
                      }}
                    />
                  )}
                  <AiPanel
                    project={project}
                    workflowId={meta?.latestId ?? null}
                    doc={doc}
                    selected={selection?.kind === 'node' ? [selection.id] : []}
                    canEdit={!readOnly}
                    initialMode={aiMode}
                    initialRun={params.get('run')}
                    initialThread={params.get('aiThread')}
                    onThread={onAiThread}
                    onProposal={onAiProposal}
                    onClose={() => {
                      if (review !== null) endReview(null);
                      setAiOpen(false);
                    }}
                  />
                </aside>
              ) : null}
              {textOpen ? (
                <aside
                  aria-label={ed.textView}
                  className="absolute inset-0 z-[6] flex flex-col bg-dy-card lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-dy-line"
                >
                  <TextPanel
                    doc={doc}
                    readOnly={readOnly}
                    onApply={(next) => {
                      commit(withAllPositions(next), 'text');
                    }}
                    onClose={() => {
                      setTextOpen(false);
                    }}
                  />
                </aside>
              ) : null}
              <aside
                aria-label={ed.inspector}
                data-testid="workflow-inspector"
                className={cx(
                  'z-[5] flex-col bg-dy-card lg:static lg:flex lg:w-[360px] lg:shrink-0 lg:border-l lg:border-dy-line',
                  sheet
                    ? 'absolute inset-x-0 bottom-0 flex max-h-[62%] rounded-t-[16px] border-t border-dy-line shadow-dy-pop lg:max-h-none lg:rounded-none lg:border-t-0 lg:shadow-none'
                    : 'hidden',
                )}
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-dy-line px-4 py-2.5">
                  <h2 className="m-0 min-w-0 flex-1 truncate text-[0.9375rem] font-bold">{inspectorTitle}</h2>
                  {selection === null ? null : (
                    <DyButton
                      variant="ghost"
                      onClick={() => {
                        setSelection(null);
                      }}
                    >
                      {ed.settings}
                    </DyButton>
                  )}
                  <button
                    type="button"
                    aria-label={ed.closeInspector}
                    onClick={() => {
                      setSheet(false);
                    }}
                    className="dy-press grid size-8 place-items-center rounded-lg text-dy-muted lg:hidden"
                  >
                    <DyIcon name="xc" className="size-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  {selectedNode !== null && isTypedNode(selectedNode) && catalog !== null ? (
                    <TypedNodeInspector
                      doc={doc}
                      node={selectedNode}
                      catalog={catalog}
                      issues={nodeIssues}
                      readOnly={readOnly}
                      project={project}
                      workflowId={meta?.id ?? null}
                      onRename={(to) => {
                        commit(renameNode(doc, selectedNode.id, to));
                        setSelection({ kind: 'node', id: to });
                      }}
                      onPatch={(patch, tag) => {
                        commit(updateNode(doc, selectedNode.id, patch), tag);
                      }}
                      onDelete={() => {
                        remove([selectedNode.id], []);
                      }}
                    />
                  ) : selectedNode !== null && isAiNode(selectedNode) ? (
                    <NodeInspector
                      doc={doc}
                      node={selectedNode}
                      issues={nodeIssues}
                      readOnly={readOnly}
                      promptsHidden={meta?.promptsHidden ?? false}
                      onEdit={commit}
                      onRename={(to) => {
                        commit(renameNode(doc, selectedNode.id, to));
                        setSelection({ kind: 'node', id: to });
                      }}
                      onPatch={(patch, tag) => {
                        commit(updateNode(doc, selectedNode.id, patch), tag);
                      }}
                      onDelete={() => {
                        remove([selectedNode.id], []);
                      }}
                    />
                  ) : selectedEdge !== null ? (
                    <EdgeInspector
                      from={
                        selectedEdge.fromPort === undefined
                          ? selectedEdge.from
                          : `${selectedEdge.from}.${selectedEdge.fromPort}`
                      }
                      to={selectedEdge.to}
                      issues={mapped?.byEdge.get(edgeKey(selectedEdge)) ?? []}
                      readOnly={readOnly}
                      onDelete={() => {
                        remove([], [edgeKey(selectedEdge)]);
                      }}
                    />
                  ) : (
                    <WorkflowSettings
                      doc={doc}
                      isNew={isNew}
                      project={project}
                      projects={props.projects.filter((p) => canDefine(props.projects, p.id))}
                      issues={mapped?.general ?? []}
                      readOnly={readOnly}
                      onProject={(p) => {
                        setProject(p);
                        setChecked(null);
                      }}
                      onEdit={commit}
                      v2={v2}
                    />
                  )}
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>
      {meta === null || !hasBoundTriggers ? null : (
        <ActivationDialog
          open={activationOpen}
          workflowId={shared === null ? meta.latestId : meta.id}
          dirty={dirty}
          canActivate={allowed}
          {...(shared === null ? {} : { project: shared.project })}
          onClose={() => {
            setActivationOpen(false);
          }}
        />
      )}
      {meta === null ? null : (
        <VersionsDialog
          open={versionsOpen}
          workflowId={meta.id}
          current={doc}
          currentVersion={meta.version}
          canRestore={allowed && !meta.archived && shared === null}
          {...(shared === null ? {} : { project: shared.project })}
          onClose={() => {
            setVersionsOpen(false);
          }}
          onOpenVersion={(id) => {
            setVersionsOpen(false);
            void navigate(
              shared === null
                ? `/workflows/${encodeURIComponent(id)}`
                : `/workflows/${encodeURIComponent(id)}?project=${encodeURIComponent(shared.project)}`,
            );
          }}
          onRestore={(restored, version) => {
            setVersionsOpen(false);
            commit(withAllPositions(restored));
            if (old) setRestoredFrom(meta.version);
            say(ed.restored({ version }));
          }}
        />
      )}
      {meta === null || shared !== null ? null : (
        <ShareDialog
          open={shareOpen}
          workflowId={meta.latestId}
          ownerProject={meta.project}
          projects={props.projects}
          canShare={isProjectAdmin(props.projects, meta.project) && !meta.archived}
          onClose={() => {
            setShareOpen(false);
          }}
        />
      )}
      {meta === null || shared === null ? null : (
        <AttachmentDialog
          open={attachmentOpen}
          attachmentId={shared.id}
          doc={doc}
          canManage={isProjectAdmin(props.projects, shared.project)}
          onClose={() => {
            setAttachmentOpen(false);
          }}
          onChanged={(a) => {
            // A new version (accepted / moved) opens that version here.
            if (a.definitionId !== null && a.definitionId !== meta.id) {
              setAttachmentOpen(false);
              void navigate(
                `/workflows/${encodeURIComponent(a.definitionId)}?project=${encodeURIComponent(a.project)}`,
                { replace: true },
              );
            }
          }}
          onDetached={() => {
            setAttachmentOpen(false);
            void navigate('/workflows', { replace: true });
          }}
          onCopy={() => {
            setAttachmentOpen(false);
            setCopyOpen(true);
          }}
        />
      )}
      {meta === null || shared === null ? null : (
        <CopyToProjectDialog
          source={copyOpen ? { id: meta.id, name: meta.name, project: shared.project } : null}
          onClose={() => {
            setCopyOpen(false);
          }}
          onDone={(id) => {
            setCopyOpen(false);
            void navigate(`/workflows/${encodeURIComponent(id)}`);
          }}
        />
      )}
    </ScreenFrame>
  );
}

// ------------------------------------------------------------------------------------------------ screen

/**
 * p14-workflow-engine 14.5: the chat draft in the router state (`{ draft }` from a workflow card's "Editörde aç"), as
 * an editor document; null without one, 'unreadable' when it does not parse. The document is the assistant's: it is
 * only the unsaved working copy — saving goes through the normal validation, privilege and step-up checks.
 */
const draftCache = new WeakMap<object, Doc | 'unreadable'>();
export function chatDraftDoc(state: unknown): Doc | 'unreadable' | null {
  const raw = typeof state === 'object' && state !== null ? (state as { draft?: unknown }).draft : undefined;
  if (typeof raw !== 'object' || raw === null) return null;
  const hit = draftCache.get(raw);
  if (hit !== undefined) return hit;
  const r = asDoc(raw);
  const doc = 'error' in r ? 'unreadable' : r.doc;
  draftCache.set(raw, doc);
  return doc;
}

/** `/workflows/new` (id null) and `/workflows/:id` (a definition version id). */
export default function WorkflowEditorScreen(props: { readonly id: string | null }): ReactNode {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [params] = useSearchParams();
  const location = useLocation();
  const t = useT();
  const w = t.workflows;
  const chatDraft = w.chatDraft;
  const { id } = props;
  const via = id === null ? '' : (params.get('project') ?? '');
  // p14-workflow-engine 14.5: "Editörde aç" on a chat card hands the drafted document over as router state.
  const drafted = chatDraftDoc(location.state);

  const load = useCallback(() => {
    setError(null);
    // p14: the node catalog only when the master reports the new engine (else the v1 editor, unchanged).
    const catalog: Promise<WorkflowCatalog | null> = getSession()
      .then((s) => (s.features?.workflowEngineV2 === true ? getWorkflowCatalog() : null))
      .catch(() => null);
    const draft = drafted === null || drafted === 'unreadable' ? null : withAllPositions(drafted);
    if (id === null) {
      void catalog.then((c) => {
        setLoaded({ meta: null, doc: draft ?? emptyDoc(w.model), catalog: c });
      });
      return;
    }
    // p18-multi-project: `?project=` opens it through a project that attached it.
    Promise.all([getWorkflowDocument(id, via === '' ? {} : { project: via }), catalog]).then(
      ([d, c]) => {
        const r = asDoc(d.definition, w.model);
        if ('error' in r) {
          setError(new ApiError(0, 'unexpected_response', r.error));
          return;
        }
        const base = withAllPositions(r.doc);
        setLoaded(
          draft === null ? { meta: d, doc: base, catalog: c } : { meta: d, doc: draft, base, catalog: c },
        );
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [id, drafted, w, via]);
  useEffect(load, [load]);
  useEffect(() => {
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, []);

  if (loaded === null || projects === null) {
    return (
      <ScreenFrame
        title={w.editor.workflow}
        back={{ to: '/workflows', label: w.editor.back }}
        testId="dy-workflow-editor"
      >
        {error === null ? (
          <SkeletonRows label={w.editor.loading} rows={4} />
        ) : (
          <ErrorLine error={error} what={w.editor.workflow} onRetry={load} />
        )}
      </ScreenFrame>
    );
  }
  const wanted = params.get('project') ?? '';
  const definable = projects.filter((p) => canDefine(projects, p.id));
  const initialProject = definable.some((p) => p.id === wanted) ? wanted : (definable[0]?.id ?? '');
  const state = location.state as {
    saved?: unknown;
    sharing?: { advanced?: unknown; pending?: unknown };
  } | null;
  const sharedNote =
    state?.sharing === undefined
      ? ''
      : ` ${t.workflowSharing.editor.savedSharing({
          advanced: Array.isArray(state.sharing.advanced) ? state.sharing.advanced.length : 0,
          pending: Array.isArray(state.sharing.pending) ? state.sharing.pending.length : 0,
        })}`;
  const savedNotice =
    typeof state?.saved === 'number'
      ? `${w.editor.savedVersion({ version: state.saved })}${sharedNote}`
      : drafted === null
        ? null
        : drafted === 'unreadable'
          ? chatDraft.editorUnreadable
          : chatDraft.editorOpened;
  return (
    <Editor loaded={loaded} projects={projects} initialProject={initialProject} savedNotice={savedNotice} />
  );
}
