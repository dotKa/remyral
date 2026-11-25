import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../components/ui';
import { floatingRoot, type PlaceOptions, SHEET_CLASSES, useFloating } from './floating';
import { presenceProps, usePresence } from './motion';

/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.3): the one floating surface of the Diyalog UI — a dropdown /
 * menu / popover next to its button on wider screens, a bottom sheet over a scrim on phones.
 *
 *   placement  `useFloating` (flip, shift, max height with inner scroll, live on scroll / resize);
 *   layer      rendered into the Diyalog scope root (portal), so a transformed / blurred ancestor (sticky headers
 *              with backdrop blur, drawers) never clips or offsets it, and it keeps the Diyalog tokens;
 *   motion     opens from its button (`dy-m-pop`) or rises as a sheet (`dy-m-sheet`); leaves the same way, inert;
 *              none under reduced motion (motion.css).
 *
 * Behaviour (focus, Escape, outside click, roles) stays with the caller: `panelRef` is the panel element, so an
 * outside-click check can include it.
 */
export function DyPopover(props: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly panelRef?: RefObject<HTMLDivElement | null> | undefined;
  /** The scrim of the phone sheet was tapped. */
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly role?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly testId?: string | undefined;
  readonly onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  /** Panel classes on wider screens (width, padding, layout). */
  readonly className?: string | undefined;
  /** Panel classes of the phone sheet (padding, layout; the sheet sets position and size). */
  readonly sheetClassName?: string | undefined;
  readonly align?: PlaceOptions['align'];
  /** Re-place after the content changed (e.g. a confirmation replaced the items). */
  readonly contentKey?: string | undefined;
}): ReactNode {
  const own = useRef<HTMLDivElement>(null);
  const panel = props.panelRef ?? own;
  const p = usePresence(props.open, panel);
  const scrim = usePresence<HTMLDivElement>(props.open);
  const f = useFloating(
    p.mounted,
    props.anchorRef,
    panel,
    props.align === undefined ? {} : { align: props.align },
  );
  const { update } = f;
  useLayoutEffect(() => {
    if (props.open) update();
  }, [props.contentKey, props.open, update]);
  if (!p.mounted) return null;
  const root = floatingRoot(props.anchorRef.current);
  if (root === null) return null;
  return createPortal(
    <>
      {f.sheet && scrim.mounted ? (
        <div
          ref={scrim.ref}
          aria-hidden="true"
          data-state={scrim.state}
          data-testid="dy-popover-scrim"
          onClick={props.onDismiss}
          className="dy-m-fade fixed inset-0 z-50 bg-dy-scrim"
        />
      ) : null}
      <div
        ref={panel}
        id={props.id}
        role={props.role}
        aria-label={props.ariaLabel}
        data-testid={props.testId}
        data-sheet={f.sheet ? 'true' : undefined}
        data-side={f.side ?? undefined}
        onKeyDown={props.onKeyDown}
        {...presenceProps(p)}
        style={f.style}
        className={cx(
          'dy-surface border border-dy-line bg-dy-card text-dy-ink shadow-dy-pop',
          f.sheet
            ? cx(SHEET_CLASSES, 'dy-m-sheet pb-[env(safe-area-inset-bottom)]', props.sheetClassName)
            : cx('dy-m-pop z-50 overflow-y-auto overscroll-contain rounded-[14px]', props.className),
        )}
      >
        {props.children}
      </div>
    </>,
    root,
  );
}

/**
 * p17-ui-batch: the list of a combobox / autocomplete field (the model picker, the expression field) — a `<ul>` that
 * lies OVER everything instead of inside its field's box: portalled to the floating root (inside a modal dialog: that
 * dialog, so it stays in the dialog's focus scope and above its backdrop; elsewhere the Diyalog scope root),
 * `position: fixed` under the field (at least its width), flipped above it when there is no room below, kept inside the
 * visible window with an inner scroll. A dialog's or panel's scrolling box therefore never cuts it off. It never turns
 * into a phone sheet (the keyboard is up while the field is focused).
 *
 * Behaviour stays with the field: focus never moves into the list (options keep it with `mousedown` →
 * `preventDefault`), the field handles the keys (Escape closes the list first — the field stops it, so the dialog
 * stays) and an outside-click check must include `listRef` (the list is no longer inside the field's wrapper).
 */
export function DyFloatingList(props: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly listRef?: RefObject<HTMLUListElement | null> | undefined;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly role?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly testId?: string | undefined;
  /** Look of the list (border, background, padding, a `max-h-*` cap); position and size come from the placement. */
  readonly className?: string | undefined;
  /** Re-place after the options changed. */
  readonly contentKey?: string | undefined;
}): ReactNode {
  const own = useRef<HTMLUListElement>(null);
  const list = props.listRef ?? own;
  const f = useFloating(props.open, props.anchorRef, list, {
    align: 'start',
    matchWidth: true,
    phoneSheet: false,
  });
  const { update } = f;
  useLayoutEffect(() => {
    if (props.open) update();
  }, [props.contentKey, props.open, update]);
  if (!props.open) return null;
  const root = floatingRoot(props.anchorRef.current);
  if (root === null) return null;
  return createPortal(
    <ul
      ref={list}
      id={props.id}
      role={props.role}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      data-side={f.side ?? undefined}
      data-floating="list"
      style={f.style}
      className={cx('dy-surface z-50 m-0 list-none overflow-y-auto overscroll-contain', props.className)}
    >
      {props.children}
    </ul>,
    root,
  );
}
