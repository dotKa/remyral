import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { altComboLetter, dialogOpen, isTyping } from './keys';

/**
 * p6-ui-refactor §5.6 keyboard shortcuts, moved to modifier combos by p17-toasts-shortcuts
 * (docs/design/p17-toasts-shortcuts.md §3): Option / Alt + a letter jumps to a page (the old `g` then a letter),
 * Option / Alt + N starts a new job (the old bare `n`), `/` focuses the page's search and `?` shows the list.
 * Combos match the physical key (`event.code`, shell/keys.ts). Nothing fires while typing (inputs, textareas,
 * selects, contenteditable) or while a modal dialog is open; `/` and `?` are not letters and never change the page.
 */
export interface GoTo {
  /** The combo letter (Option / Alt + this). */
  readonly letter: string;
  readonly to: string;
  readonly label: string;
}

export const GO_TO: readonly GoTo[] = [
  { letter: 'h', to: '/', label: 'Home' },
  { letter: 'c', to: '/chat', label: 'Chat' },
  // p17-needs-page: "Senden bekleyenler" (approvals, pairings, questions) — the old `g a` went to /approvals.
  { letter: 'a', to: '/needs', label: 'Needs you' },
  { letter: 'j', to: '/jobs', label: 'Jobs' },
  { letter: 'm', to: '/machines', label: 'Machines' },
  { letter: 'p', to: '/projects', label: 'Projects' },
  { letter: 's', to: '/settings', label: 'Settings' },
];

/** Option / Alt + N: the new-job form. */
export const NEW_JOB_LETTER = 'n';
/** Option / Alt + T: the keyboard goes to the newest toast (DyToaster). */
export const TOAST_FOCUS_LETTER = 't';
/** Option / Alt + D: voice dictation in the Sohbet composer (also while typing in it). */
export const DICTATION_LETTER = 'd';
/**
 * p18-plan-mode: Option / Alt + L opens / closes the plan panel of the Sohbet conversation (the design note said Alt + P,
 * which has been "Projeler" since p17-toasts-shortcuts — kept, so L for pLan).
 */
export const PLAN_LETTER = 'l';

/** The page's search field: an element marked `data-page-search`, else the first `input[type=search]`. */
export function findPageSearch(root: ParentNode = document): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('[data-page-search]') ??
    root.querySelector<HTMLElement>('main input[type="search"]')
  );
}

export function useShortcuts(onHelp: () => void): void {
  const navigate = useNavigate();
  const help = useRef(onHelp);
  help.current = onHelp;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      if (isTyping(e.target)) return;
      if (dialogOpen()) return;
      const letter = altComboLetter(e);
      if (letter !== null) {
        const target = GO_TO.find((g) => g.letter === letter);
        if (target !== undefined) {
          e.preventDefault();
          void navigate(target.to);
          return;
        }
        if (letter === NEW_JOB_LETTER) {
          e.preventDefault();
          void navigate('/jobs/new');
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        help.current();
        return;
      }
      if (e.key === '/') {
        const search = findPageSearch();
        if (search) {
          e.preventDefault();
          search.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [navigate]);
}
