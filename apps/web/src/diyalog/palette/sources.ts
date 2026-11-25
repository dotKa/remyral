import { useCallback, useEffect, useRef, useState } from 'react';
import { listApprovals } from '../../api/approvals';
import { listAutomations } from '../../api/automations';
import { type ChatThread, listThreads } from '../../api/chat';
import { listProjects } from '../../api/directory';
import { listJobs } from '../../api/jobs';
import { listTemplates } from '../../api/templates';
import { listWorkers } from '../../api/workers';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../i18n/I18nProvider';
import type { IconName } from '../icons';
import { altLabel } from '../../shell/keys';
import { GO_TO, NEW_JOB_LETTER } from '../../shell/shortcuts';

/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.1): what the command palette can reach.
 *
 *   static   every screen and its tabs / sub-pages (catalog names, both languages' words as keywords), settings filtered by
 *            role by the caller (`useSettingsGroups`);
 *   index    a lightweight snapshot of the caller's conversations, recent jobs, machines, projects, automations,
 *            templates and pending approvals — prefetched once the browser is idle, refreshed when the palette opens
 *            and the snapshot is older than a minute. Every list comes from the endpoint the screen itself uses, with
 *            the caller's session: the master returns only what they may see; a list they may not read stays empty.
 */

export type SectionId =
  | 'recent'
  | 'actions'
  | 'pages'
  | 'chats'
  | 'approvals'
  | 'jobs'
  | 'machines'
  | 'projects'
  | 'outputs'
  | 'automations'
  | 'templates'
  | 'ai';

export interface PaletteItem {
  /** Unique across the palette (`page:/jobs`, `chat:<id>`, …). */
  readonly id: string;
  readonly section: SectionId;
  readonly label: string;
  readonly hint?: string | undefined;
  /** Extra words that find it (English names, ids). */
  readonly keywords?: string | undefined;
  readonly icon: IconName;
  /** A console path to open. */
  readonly to?: string | undefined;
  /** An action (not remembered in "Son kullanılanlar"). */
  readonly action?: string | undefined;
  /** "anlama göre" / "kelimeyle" (AI results). */
  readonly badge?: string | undefined;
}

const page = (to: string, label: string, icon: IconName, keywords: string, hint?: string): PaletteItem => ({
  id: `page:${to}`,
  section: 'pages',
  label,
  to,
  icon,
  keywords,
  hint,
});

/**
 * Every screen, its tabs and sub-pages (settings come from the role-filtered settings groups), in the current
 * language. Keywords carry the English and the Turkish words, so an item is found by either language's name.
 */
export function palettePages(t: Messages): readonly PaletteItem[] {
  return withComboHints(basePages(t));
}

/**
 * p17-toasts-shortcuts: a page with an Option / Alt shortcut shows it as its hint ("⌥J" / "Alt+J") — where the item
 * has no hint of its own.
 */
export function withComboHints(items: readonly PaletteItem[]): readonly PaletteItem[] {
  const combo = new Map<string, string>([
    ...GO_TO.map((g) => [g.to, altLabel(g.letter)] as const),
    ['/jobs/new', altLabel(NEW_JOB_LETTER)],
  ]);
  return items.map((i) => {
    const keys = i.to === undefined ? undefined : combo.get(i.to);
    return keys === undefined || i.hint !== undefined ? i : { ...i, hint: keys };
  });
}

function basePages(t: Messages): readonly PaletteItem[] {
  const n = t.nav;
  const p = t.palette.page;
  return [
    page('/', n.home, 'home', 'home dashboard pano ana sayfa'), // i18n-ignore: search keywords
    page('/chat', n.chat, 'bubble', 'chat assistant asistan sohbet'), // i18n-ignore: search keywords
    page('/jobs', n.jobs, 'jobs', 'jobs tüm işler'), // i18n-ignore: search keywords
    page('/jobs?tab=queue', p.queue, 'jobs', 'queue jobs işler kuyruk', n.jobs), // i18n-ignore: search keywords
    page('/jobs/new', t.palette.action.newJob, 'plus', 'new job composer yeni iş formu'), // i18n-ignore: search keywords
    page('/jobs/templates', p.templates, 'file', 'templates şablonlar'), // i18n-ignore: search keywords
    page('/jobs/schedules', p.schedules, 'clock', 'schedules cron scheduled jobs zamanlanmış işler'), // i18n-ignore: search keywords
    // p17-needs-page: the decisions page (live cards and the needs-you rows).
    page('/needs', n.needs, 'shield', 'needs you decisions senden bekleyenler kararlar'), // i18n-ignore: search keywords
    // p18-plans-ui: every plan of the person.
    page('/plans', n.plans, 'flag', 'plans roadmap planlar plan yol haritası'), // i18n-ignore: search keywords
    page('/approvals', p.approvals, 'shield', 'approvals onaylar onay geçmişi'), // i18n-ignore: search keywords
    page('/machines', n.machines, 'cpu', 'machines workers fleet makineler'), // i18n-ignore: search keywords
    page('/machines/add', p.addMachine, 'plus', 'add machine pair eşleştir makine ekle', n.machines), // i18n-ignore: search keywords
    page('/projects', n.projects, 'folder', 'projects projeler'), // i18n-ignore: search keywords
    page('/outputs', n.outputs, 'tray', 'outputs sites files çıktılar'), // i18n-ignore: search keywords
    page('/automations', p.automations, 'retry', 'automations triggers webhook otomasyonlar'), // i18n-ignore: search keywords
    page('/deploys', p.deploys, 'rocket', 'deploys deployments yayın deploy’lar'), // i18n-ignore: search keywords
    page('/uptime', p.uptime, 'globe', 'uptime monitors erişilebilirlik'), // i18n-ignore: search keywords
    page('/usage', n.usage, 'gauge', 'usage cost maliyet kullanım'), // i18n-ignore: search keywords
    page('/usage?tab=dashboard', p.usageDashboard, 'gauge', 'usage dashboard pano', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=suggestions', p.usageSuggestions, 'gauge', 'usage suggestions öneriler', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=reports', p.usageReports, 'gauge', 'usage reports raporlar', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=overview', p.usageOverview, 'gauge', 'usage overview cost maliyet dökümü', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=outcomes', p.usageOutcomes, 'gauge', 'usage outcomes sonuçlar', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=prices', p.usagePrices, 'gauge', 'usage prices fiyatlar', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=budgets', p.usageBudgets, 'gauge', 'usage budgets bütçeler', n.usage), // i18n-ignore: search keywords
    page('/usage?tab=enforcement', p.usageEnforcement, 'gauge', 'usage limits quotas kotalar', n.usage), // i18n-ignore: search keywords
    page('/skills', p.skills, 'brain', 'skills beceriler yetenekler'), // i18n-ignore: search keywords
    page('/context', p.context, 'brain', 'context memory hafıza bağlam'), // i18n-ignore: search keywords
    page('/audit', p.audit, 'shield', 'audit log denetim kaydı'), // i18n-ignore: search keywords
    page('/settings', n.settings, 'gear', 'settings ayarlar'), // i18n-ignore: search keywords
  ];
}

/** The settings sub-pages the caller may open (from `useSettingsGroups`); `settings` is the hint ("Ayarlar"). */
export function settingsPages(
  groups: readonly { readonly items: readonly { readonly path: string; readonly label: string }[] }[],
  settings: string,
): PaletteItem[] {
  return groups.flatMap(
    (g) =>
      g.items.map((i) => page(i.path, i.label, 'gear', `settings ayarlar ${i.path.slice(10)}`, settings)), // i18n-ignore: search keywords
  );
}

export interface PaletteIndex {
  readonly chats: readonly PaletteItem[];
  readonly approvals: readonly PaletteItem[];
  readonly jobs: readonly PaletteItem[];
  readonly machines: readonly PaletteItem[];
  readonly projects: readonly PaletteItem[];
  readonly automations: readonly PaletteItem[];
  readonly templates: readonly PaletteItem[];
}

export const EMPTY_INDEX: PaletteIndex = {
  chats: [],
  approvals: [],
  jobs: [],
  machines: [],
  projects: [],
  automations: [],
  templates: [],
};

/** Conversations: pinned first, then most recently active. */
export function chatItems(threads: readonly ChatThread[], t: Messages['palette']): PaletteItem[] {
  return [...threads]
    .sort((a, b) => {
      const pa = a.pinnedAt != null ? 1 : 0;
      const pb = b.pinnedAt != null ? 1 : 0;
      return pb - pa || b.updatedAt.localeCompare(a.updatedAt);
    })
    .map((c) => ({
      id: `chat:${c.id}`,
      section: 'chats' as const,
      label: c.title,
      hint: c.pinnedAt != null ? t.hint.pinned : c.archived ? t.hint.archived : undefined,
      icon: 'bubble' as const,
      to: `/chat/${encodeURIComponent(c.id)}`,
    }));
}

async function settle<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch {
    return empty; // not allowed / not available: the palette simply has nothing of it
  }
}

/** Loads the index (each list independently; a refused list stays empty). */
export async function loadIndex(t: Messages['palette']): Promise<PaletteIndex> {
  const jobState: Readonly<Record<string, string>> = t.jobState;
  const [threads, approvals, jobs, workers, projects, automations, templates] = await Promise.all([
    settle(listThreads(), []),
    settle(listApprovals('pending'), []),
    settle(
      listJobs({}, null, { limit: 50 }).then((p) => p.items),
      [],
    ),
    settle(listWorkers(), []),
    settle(listProjects(), []),
    settle(listAutomations(), []),
    settle(listTemplates({ state: 'active' }), []),
  ]);
  return {
    chats: chatItems(threads, t),
    approvals: approvals.map((a) => ({
      id: `approval:${a.id}`,
      section: 'approvals' as const,
      label: a.summary || a.requestedAction,
      hint: `${a.project} · ${t.risk[a.risk]}`,
      keywords: `${a.action} ${a.id} ${a.jobId} ${a.risk}`,
      icon: 'shield' as const,
      to: `/approvals/${encodeURIComponent(a.id)}`,
    })),
    jobs: jobs.map((j) => ({
      id: `job:${j.id}`,
      section: 'jobs' as const,
      label: j.title || j.id.slice(0, 8),
      hint: `${j.id.slice(0, 8)} · ${j.project} · ${jobState[j.state] ?? j.state.toLowerCase()}`,
      keywords: `${j.id} ${j.state} ${j.project} ${j.runtime ?? ''}`,
      icon: 'jobs' as const,
      to: `/jobs/${encodeURIComponent(j.id)}`,
    })),
    machines: workers.map((w) => ({
      id: `machine:${w.id}`,
      section: 'machines' as const,
      label: w.name,
      hint: [w.connected ? t.hint.connected : t.hint.disconnected, w.os, w.arch]
        .filter((x) => x !== null)
        .join(' · '),
      keywords: `${w.id} ${w.state}`,
      icon: 'cpu' as const,
      to: `/machines/${encodeURIComponent(w.id)}`,
    })),
    projects: projects.map((p) => ({
      id: `project:${p.id}`,
      section: 'projects' as const,
      label: p.name,
      hint: p.name === p.id ? undefined : p.id,
      keywords: p.id,
      icon: 'folder' as const,
      to: `/projects/${encodeURIComponent(p.id)}`,
    })),
    automations: automations
      .filter((a) => a.state !== 'deleted')
      .map((a) => ({
        id: `automation:${a.id}`,
        section: 'automations' as const,
        label: a.name,
        hint: a.project,
        keywords: `${a.id} ${a.description ?? ''}`,
        icon: 'retry' as const,
        to: `/automations/${encodeURIComponent(a.id)}`,
      })),
    templates: templates.map((x) => ({
      id: `template:${x.id}`,
      section: 'templates' as const,
      label: x.title,
      hint: x.project ?? t.hint.allProjects,
      keywords: `${x.tags.join(' ')} ${x.description}`,
      icon: 'file' as const,
      to: `/jobs/templates/${encodeURIComponent(x.id)}`,
    })),
  };
}

const STALE_MS = 60_000;

/**
 * The index for the signed-in shell: prefetched when the browser is idle (≤ 2 s after mount), refreshed by
 * `refresh()` (the palette opening) when older than a minute. Disabled (`enabled` false) loads nothing.
 */
export function usePaletteIndex(enabled: boolean): {
  readonly index: PaletteIndex;
  readonly loaded: boolean;
  readonly refresh: () => void;
} {
  const t = useT().palette;
  const words = useRef(t);
  words.current = t;
  const [index, setIndex] = useState<PaletteIndex>(EMPTY_INDEX);
  const [loaded, setLoaded] = useState(false);
  const at = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const load = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    at.current = Date.now();
    loadIndex(words.current).then(
      (i) => {
        busy.current = false;
        if (!alive.current) return;
        setIndex(i);
        setLoaded(true);
      },
      () => {
        busy.current = false;
      },
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let idle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof w.requestIdleCallback === 'function') idle = w.requestIdleCallback(load, { timeout: 2000 });
    else timer = setTimeout(load, 1200);
    return () => {
      alive.current = false;
      if (idle !== null && typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(idle);
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, load]);
  // A language change makes the snapshot's hints stale: the next open reloads it.
  useEffect(() => {
    at.current = 0;
  }, [t]);
  const refresh = useCallback(() => {
    if (Date.now() - at.current > STALE_MS) load();
  }, [load]);
  return { index, loaded, refresh };
}
