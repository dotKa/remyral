import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';
import { usePaletteOpener } from './palette/opener';
import { RailClock } from './ShellExtras';
import { DyAccountMenu, DyNotificationBell } from './topbar';

/**
 * p12-diyalog-parity: the top bar's tools of the Sohbet screen (§13) — the notification bell with its list, the
 * account menu, the server clock where the rail does not show it (640–767 px), the palette button on phones.
 */

/** p12-diyalog-cmdk: the command palette on phones / narrow windows (the rail has its own button from 768 px). */
function PaletteButton(): ReactNode {
  const open = usePaletteOpener();
  const t = useT().shell;
  if (open === null) return null;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={t.search}
      title={t.searchTitle}
      onClick={open}
      data-testid="dy-palette-top"
      className="dy-press grid size-11 place-items-center rounded-[10px] text-dy-muted sm:size-9 md:hidden [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
    >
      <DyIcon name="search" className="size-5" />
    </button>
  );
}

export function TopTools(): ReactNode {
  return (
    <div className="ml-auto flex items-center gap-1">
      <div className="flex items-center gap-1" data-testid="dy-top-tools">
        <PaletteButton />
        {/* From 768 px the nav rail shows the server clock (RailClock); here only for 640–767 px, as classic. */}
        <span className="hidden sm:inline-flex md:hidden">
          <RailClock layout="bar" />
        </span>
        <DyNotificationBell />
        <DyAccountMenu />
      </div>
    </div>
  );
}
