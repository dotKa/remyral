import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useT } from '../../i18n/I18nProvider';
import { DyDialog } from '../DyDialog';
import { DyNotice } from '../common/notices';
import { DyButton } from '../screens/parts';

/**
 * p15-form-pattern (docs/design/p15-form-pattern.md §5): the unsaved-changes guard. Forms (a tab's `DyFormScope`, a
 * standalone `useDyForm`) register here while they hold edits; leaving them — another tab (`DyTabs`), an in-app link
 * (rail, breadcrumbs, any `<a href>` inside the app) or the browser (reload, close, an outside address) — asks first:
 * "Kaydet / Kaydetmeden çık / Vazgeç". Save runs every dirty form's own save (their errors stay in the form, the page
 * does not change); "Kaydetmeden çık" drops the edits; "Vazgeç" stays. Instant switches never register (they are
 * saved already). Without a provider (a bare component) only the browser-unload warning remains.
 */

export interface GuardEntry {
  readonly dirty: boolean;
  /** Saves this form's edits; true when everything was saved (a cancelled step-up or a refusal is false). */
  readonly save: () => Promise<boolean>;
  /** Drops the edits (back to the loaded value). */
  readonly discard: () => void;
}

interface GuardApi {
  /** Registers / updates an entry; the returned function removes it. */
  readonly put: (id: string, entry: GuardEntry) => void;
  readonly remove: (id: string) => void;
  /** True when nothing is dirty or the person chose to save (successfully) or leave; false to stay. */
  readonly confirmLeave: () => Promise<boolean>;
  /** Whether any registered form holds edits right now (a clean leave needs no question and no wait). */
  readonly isDirty: () => boolean;
}

const GuardContext = createContext<GuardApi | null>(null);

/** The guard of the nearest provider (null outside one). */
export function useLeaveGuard(): GuardApi | null {
  return use(GuardContext);
}

/** An in-app link a click on which leaves the current view (same origin, plain left click, another path / query). */
function leavingHref(e: MouseEvent, current: { pathname: string; search: string }): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const a = target.closest('a[href]');
  if (!(a instanceof HTMLAnchorElement)) return null;
  if (a.target !== '' && a.target !== '_self') return null;
  if (a.hasAttribute('download')) return null;
  const raw = a.getAttribute('href') ?? '';
  if (raw === '' || raw.startsWith('#') || /^(mailto|tel):/i.test(raw)) return null;
  let url: URL;
  try {
    // Resolved against the router's location (a MemoryRouter's location is not window.location).
    url = new URL(raw, `${window.location.origin}${current.pathname}${current.search}`);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null; // the browser's own unload prompt covers it
  if (url.pathname === current.pathname && url.search === current.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The provider (mounted by `ScreenFrame`, reused when nested). It renders the leave dialog and, only while something
 * is dirty, listens for in-app link clicks (capture phase, before the router's own handler) and `beforeunload`.
 */
export function UnsavedGuardProvider(props: { readonly children: ReactNode }): ReactNode {
  const parent = use(GuardContext);
  if (parent !== null) return props.children;
  return <GuardRoot>{props.children}</GuardRoot>;
}

function GuardRoot(props: { readonly children: ReactNode }): ReactNode {
  const t = useT().forms.guard;
  const entries = useRef(new Map<string, GuardEntry>());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location);
  here.current = location;

  const recount = useCallback(() => {
    let n = 0;
    for (const e of entries.current.values()) if (e.dirty) n += 1;
    setDirtyCount(n);
  }, []);

  const put = useCallback(
    (id: string, entry: GuardEntry) => {
      entries.current.set(id, entry);
      recount();
    },
    [recount],
  );
  const remove = useCallback(
    (id: string) => {
      entries.current.delete(id);
      recount();
    },
    [recount],
  );

  const settle = useCallback((ok: boolean) => {
    setOpen(false);
    setSaving(false);
    setFailed(false);
    const resolve = pending.current;
    pending.current = null;
    resolve?.(ok);
  }, []);

  const isDirty = useCallback(() => [...entries.current.values()].some((e) => e.dirty), []);

  const confirmLeave = useCallback((): Promise<boolean> => {
    if (!isDirty()) return Promise.resolve(true);
    pending.current?.(false); // a newer question supersedes an open one
    setFailed(false);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, [isDirty]);

  const saveAll = async (): Promise<void> => {
    setSaving(true);
    setFailed(false);
    let ok = true;
    for (const e of [...entries.current.values()]) {
      if (!e.dirty) continue;
      // Sequential: two forms of one resource must not race each other's version check.
      if (!(await e.save())) {
        ok = false;
        break;
      }
    }
    if (ok) settle(true);
    else {
      setSaving(false);
      setFailed(true);
    }
  };

  const leave = (): void => {
    for (const e of entries.current.values()) if (e.dirty) e.discard();
    settle(true);
  };

  // In-app links: asked before the router sees the click; browser unload: the browser's own prompt.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onClick = (e: MouseEvent): void => {
      const to = leavingHref(e, here.current);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((ok) => {
        if (ok) void navigate(to);
      });
    };
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirtyCount, confirmLeave, navigate]);

  const api = useMemo<GuardApi>(
    () => ({ put, remove, confirmLeave, isDirty }),
    [put, remove, confirmLeave, isDirty],
  );

  return (
    <GuardContext value={api}>
      {props.children}
      <DyDialog
        open={open}
        size="sm"
        backdropClose={false}
        onClose={() => {
          if (!saving) settle(false);
        }}
        title={t.title}
        description={t.body}
        testId="dy-unsaved-dialog"
        footer={
          <>
            <DyButton
              disabled={saving}
              onClick={() => {
                settle(false);
              }}
              data-testid="unsaved-stay"
            >
              {t.stay}
            </DyButton>
            <DyButton variant="danger" disabled={saving} onClick={leave} data-testid="unsaved-leave">
              {t.leave}
            </DyButton>
            <DyButton
              variant="primary"
              busy={saving}
              onClick={() => void saveAll()}
              data-testid="unsaved-save"
            >
              {saving ? t.saving : t.save}
            </DyButton>
          </>
        }
      >
        {failed ? (
          <DyNotice tone="red" live testId="unsaved-failed">
            {t.failed}
          </DyNotice>
        ) : null}
      </DyDialog>
    </GuardContext>
  );
}

/**
 * Registers a form with the nearest guard while it is mounted; `dirty` is read on every change. Without a provider it
 * still warns on browser unload while dirty.
 */
export function useUnsavedGuard(entry: GuardEntry): void {
  const guard = use(GuardContext);
  const id = useId();
  const latest = useRef(entry);
  latest.current = entry;
  const { dirty } = entry;
  const stable = useMemo<GuardEntry>(
    () => ({
      get dirty() {
        return latest.current.dirty;
      },
      save: () => latest.current.save(),
      discard: () => {
        latest.current.discard();
      },
    }),
    [],
  );
  useEffect(() => {
    if (guard === null) return;
    guard.put(id, stable);
  }, [guard, id, stable, dirty]);
  useEffect(() => {
    if (guard === null) return;
    return () => {
      guard.remove(id);
    };
  }, [guard, id]);
  useEffect(() => {
    if (guard !== null || !dirty) return;
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [guard, dirty]);
}
