import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { useAuth } from '../../../auth/AuthProvider';
import { cx } from '../../../components/ui';
import { SETTINGS_GROUPS } from '../../../shell/settingsGroups';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon } from '../../icons';
import { ScreenFrame } from '../ScreenFrame';

/**
 * p12-diyalog Faz 4 — Ayarlar: the settings frame in the Diyalog language. The classic groups and their admin-only
 * items (`SETTINGS_GROUPS`, the single source of what a role may open) in Turkish: a list beside the page on ≥ 768
 * px, a disclosure naming the current section on phones (as the classic layout). The page title and its
 * one-line purpose come from here.
 */

export interface SectionText {
  readonly label: string;
  readonly purpose: string;
}

type SectionKey = keyof Messages['settings']['frame']['sections'];

/** Settings path → catalog key of its name and purpose. */
const SECTION_KEYS: Readonly<Record<string, SectionKey>> = {
  '/settings/profile': 'profile',
  '/settings/devices': 'devices',
  '/settings/runtimes': 'runtimes',
  '/settings/models': 'models',
  '/settings/credentials': 'credentials',
  '/settings/integrations': 'integrations',
  '/settings/chat': 'chat',
  '/settings/users': 'users',
  '/settings/releases': 'releases',
  '/settings/backups': 'backups',
  '/settings/context': 'context',
  '/settings/notifications': 'notifications',
};

/** The name and purpose of a settings section (by path) in the user's language; undefined for an unknown path. */
export function sectionText(t: Messages, path: string): SectionText | undefined {
  // p15-autonomy: Güvenlik has its own namespace.
  if (path === '/settings/security')
    return { label: t.security.page.label, purpose: t.security.page.purpose };
  // p16-api-tokens: API anahtarları, Servis hesapları and API have their own namespace.
  if (path === '/settings/api-tokens') return t.apiTokens.pages.personal;
  if (path === '/settings/service-accounts') return t.apiTokens.pages.service;
  if (path === '/settings/api') return t.apiTokens.pages.docs;
  // p16-webhooks-out: Webhook'lar has its own namespace.
  if (path === '/settings/webhooks') return t.webhooks.pages;
  // p16-ops-safety: Operasyon güvenliği has its own namespace.
  if (path === '/settings/ops-safety')
    return { label: t.opsSafety.page.label, purpose: t.opsSafety.page.purpose };
  // p17-panel-settings: Sunucu ayarları has its own namespace.
  if (path === '/settings/server-settings') return t.panelSettings.page;
  // p16-doctor: Tanılama has its own namespace.
  if (path === '/settings/diagnostics') return { label: t.doctor.page.label, purpose: t.doctor.page.purpose };
  // p16-observability: Sistem durumu has its own namespace.
  if (path === '/settings/system')
    return { label: t.systemStatus.page.label, purpose: t.systemStatus.page.purpose };
  // p19-ide W3: Geliştirme ortamı lives in the ide namespace.
  if (path === '/settings/ide-extensions') return { label: t.ide.admin.title, purpose: t.ide.admin.sub };
  // p15-workspace-retention: Çalışma dosyaları has its own namespace.
  if (path === '/settings/workfiles')
    return { label: t.workfiles.settings.title, purpose: t.workfiles.settings.sub };
  const key = SECTION_KEYS[path];
  return key === undefined ? undefined : t.settings.frame.sections[key];
}

type GroupKey = keyof Messages['settings']['frame']['groups'];

const GROUP_KEYS: Readonly<Record<string, GroupKey>> = {
  Account: 'account',
  Agents: 'agents',
  Workspace: 'workspace',
};

/**
 * p17-ui-polish: the classic Workspace group held 13 of the 23 items; Diyalog splits it into the workspace itself
 * (files, context, notifications), team and access (people, service accounts, webhooks, the API) and the system
 * (releases, backups, status, diagnostics, server settings). Paths not listed keep their classic group.
 */
const DIYALOG_GROUP: Readonly<Record<string, GroupKey>> = {
  '/settings/users': 'team',
  '/settings/service-accounts': 'team',
  '/settings/webhooks': 'team',
  '/settings/api': 'team',
  '/settings/releases': 'system',
  '/settings/backups': 'system',
  '/settings/system': 'system',
  '/settings/diagnostics': 'system',
  '/settings/server-settings': 'system',
  // p19-ide W3: Geliştirme ortamı (the IDE extension allowlist).
  '/settings/ide-extensions': 'system',
};

const GROUP_ORDER: readonly GroupKey[] = ['account', 'agents', 'workspace', 'team', 'system'];

export interface VisibleItem {
  readonly path: string;
  readonly label: string;
}

export interface VisibleGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly VisibleItem[];
}

/** The settings groups this role may open (the classic rule: admin-only items for owners and admins). */
export function useSettingsGroups(): readonly VisibleGroup[] {
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : '';
  const admin = role === 'owner' || role === 'admin';
  const all = useT();
  const t = all.settings;
  const byKey = new Map<string, VisibleItem[]>();
  for (const g of SETTINGS_GROUPS) {
    for (const i of g.items) {
      if (!admin && i.admin === true) continue;
      const key = DIYALOG_GROUP[i.path] ?? GROUP_KEYS[g.label] ?? g.label;
      const items = byKey.get(key) ?? [];
      items.push({ path: i.path, label: sectionText(all, i.path)?.label ?? i.label });
      byKey.set(key, items);
    }
  }
  const order: readonly string[] = [
    ...GROUP_ORDER,
    ...[...byKey.keys()].filter((k) => !GROUP_ORDER.includes(k as GroupKey)),
  ];
  return order.flatMap((key) => {
    const items = byKey.get(key);
    if (items === undefined || items.length === 0) return [];
    const label = (GROUP_ORDER as readonly string[]).includes(key) ? t.frame.groups[key as GroupKey] : key;
    return [{ key, label, items }];
  });
}

/** p17-ui-polish: which settings groups this viewer opened (per browser; guarded — blocked storage forgets). */
export const NAV_OPEN_KEY = 'remyral.dy.settings.nav';

function loadOpen(): Readonly<Record<string, boolean>> {
  try {
    const raw = window.localStorage.getItem(NAV_OPEN_KEY);
    const v: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

function saveOpen(open: Readonly<Record<string, boolean>>): void {
  try {
    window.localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(open));
  } catch {
    // Storage blocked (private window, policy): the choice lasts for this page only.
  }
}

function NavLinks(props: {
  readonly group: VisibleGroup;
  readonly current: string;
  readonly id?: string;
}): ReactNode {
  return (
    <ul id={props.id} className="m-0 flex list-none flex-col gap-0.5 p-0">
      {props.group.items.map((i) => {
        const active = i.path === props.current;
        return (
          <li key={i.path}>
            <Link
              to={i.path}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex min-h-9 items-center rounded-[9px] px-2.5 text-[0.875rem] no-underline',
                active
                  ? 'bg-dy-card font-bold text-dy-ink shadow-dy'
                  : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card/60 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
              )}
            >
              {i.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * p17-ui-polish: the side list's groups fold (23 items in one column were longer than most settings pages). The
 * current page's group is always open and has no toggle; the others open on a click and the choice is remembered
 * per viewer.
 */
function SideNav(props: { readonly groups: readonly VisibleGroup[]; readonly current: string }): ReactNode {
  const t = useT().settings.frame;
  const baseId = useId();
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>(loadOpen);
  return (
    <nav aria-label={t.title} className="hidden md:block">
      <div className="sticky top-[70px] flex flex-col gap-3" data-testid="dy-settings-nav">
        {props.groups.map((g) => {
          const here = g.items.some((i) => i.path === props.current);
          const listId = `${baseId}-${g.key}`;
          if (here)
            return (
              <div key={g.key} data-testid={`dy-settings-group-${g.key}`}>
                <h2 className="m-0 mb-1 px-2.5 py-1 text-[0.78125rem] font-bold text-dy-faint">{g.label}</h2>
                <NavLinks group={g} current={props.current} />
              </div>
            );
          const expanded = open[g.key] === true;
          return (
            <div key={g.key} data-testid={`dy-settings-group-${g.key}`}>
              <h2 className="m-0 mb-1 text-[0.78125rem] font-bold">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? listId : undefined}
                  onClick={() => {
                    const next = { ...open, [g.key]: !expanded };
                    setOpen(next);
                    saveOpen(next);
                  }}
                  className="dy-press flex min-h-7 w-full items-center gap-1.5 rounded-[7px] px-2.5 text-left text-dy-faint [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
                >
                  <span className="min-w-0 flex-1">{g.label}</span>
                  <span className="font-dy-mono font-medium tabular-nums" aria-hidden="true">
                    {expanded ? null : g.items.length}
                  </span>
                  <DyIcon
                    name="chev"
                    className={cx(
                      'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
                      expanded ? 'rotate-180' : '',
                    )}
                  />
                </button>
              </h2>
              {expanded ? <NavLinks group={g} current={props.current} id={listId} /> : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Phones: one disclosure naming the current section (the classic "Settings sections" behaviour), closed by default;
 * the grouped links render only while it is open, and it is keyed by the path so it closes after navigating.
 */
function PhoneNav(props: { readonly groups: readonly VisibleGroup[]; readonly current: string }): ReactNode {
  const t = useT().settings.frame;
  const [open, setOpen] = useState(false);
  const current = props.groups.flatMap((g) => g.items).find((i) => i.path === props.current);
  return (
    <details
      className="group mb-4 rounded-[12px] border border-dy-line bg-dy-card md:hidden"
      data-testid="dy-settings-disclosure"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-[0.9375rem] [&::-webkit-details-marker]:hidden">
        <DyIcon name="gear" className="size-4 shrink-0 text-dy-muted" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-dy-muted">{t.title}</span>
          {current === undefined ? null : <span className="font-bold"> · {current.label}</span>}
        </span>
        <DyIcon
          name="chev"
          className="size-4 shrink-0 text-dy-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {open ? (
        <nav aria-label={t.sectionsLabel} className="flex flex-col gap-4 border-t border-dy-line px-2 py-3">
          {props.groups.map((g) => (
            <div key={g.key}>
              <h2 className="m-0 mb-1 px-2.5 text-[0.78125rem] font-bold text-dy-faint">{g.label}</h2>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {g.items.map((i) => {
                  const active = i.path === props.current;
                  return (
                    <li key={i.path}>
                      <Link
                        to={i.path}
                        aria-current={active ? 'page' : undefined}
                        className={cx(
                          'flex min-h-11 items-center rounded-[9px] px-2.5 text-[0.9375rem] no-underline',
                          active ? 'bg-dy-sunk font-bold text-dy-ink' : 'text-dy-ink',
                        )}
                      >
                        {i.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      ) : null}
    </details>
  );
}

/** A settings page: the Diyalog frame, the settings navigation and the page. */
export function SettingsFrame(props: {
  readonly path: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const groups = useSettingsGroups();
  const all = useT();
  const t = all.settings;
  const text = sectionText(all, props.path);
  return (
    <ScreenFrame
      title={text?.label ?? t.frame.title}
      purpose={text?.purpose}
      actions={props.actions}
      testId="dy-settings"
    >
      <PhoneNav key={props.path} groups={groups} current={props.path} />
      <div className="grid grid-cols-1 gap-8 md:grid-cols-[208px_minmax(0,1fr)]">
        <SideNav groups={groups} current={props.path} />
        <div className="min-w-0" data-settings-page={props.path}>
          {props.children}
        </div>
      </div>
    </ScreenFrame>
  );
}
