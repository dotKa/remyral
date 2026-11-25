// p17-ui-batch: (1) a combobox / popover list inside a modal dialog floats over the dialog (portalled into the
// dialog, fixed, flipped up when there is no room below, inside the window) instead of being cut off by the dialog's
// scrolling box, with the keyboard / focus / Escape order kept; (2) the dialogs' enter / exit motion (rise from 0.98,
// backdrop fade, reverse on close, reduced motion instant, a reopen during the exit turns back).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeCatalog } from '../src/api/runtimeModels';
import { DyDialog } from '../src/diyalog/DyDialog';
import { DyStepUpDialog } from '../src/diyalog/DyStepUpDialog';
import { floatingRoot, place } from '../src/diyalog/floating';
import { DyModelPicker, resetRuntimeModelsCache } from '../src/diyalog/screens/shared/ModelPicker';

const motion = readFileSync(join(__dirname, '../src/diyalog/motion.css'), 'utf8');
const tokens = readFileSync(join(__dirname, '../src/diyalog/motion-tokens.css'), 'utf8');

const CATALOG: RuntimeCatalog = {
  catalogVersion: '2026.10.24-1',
  runtimes: [
    {
      runtime: 'codex',
      models: ['gpt-a', 'gpt-b', 'gpt-c', 'gpt-d', 'gpt-e', 'gpt-f'].map((id) => ({
        id,
        displayName: id,
        kind: 'model' as const,
        inCatalog: true,
        machines: [],
      })),
      machines: [],
      defaults: { global: null, project: null, machines: [] },
    },
  ],
};

function mockMatchMedia(matches: (q: string) => boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: matches(q),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

/** CSS motion on every `<dialog>` (jsdom loads no CSS): what the browser reports for `dialog.dy-dialog`. */
function stubDialogTransition(duration: string): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = real(el, pseudo);
    if (el.tagName !== 'DIALOG') return cs;
    return new Proxy(cs, {
      get(t, k) {
        if (k === 'transitionDuration') return duration;
        if (k === 'transitionDelay') return '0s';
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  });
}

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  resetRuntimeModelsCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(CATALOG), { status: 200 }))),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------------------ 1. placement

describe('lists inside modal dialogs are not clipped (floating.ts, DyFloatingList)', () => {
  it('floatingRoot: an open dialog around the anchor wins over the Diyalog scope root', () => {
    const root = document.createElement('div');
    root.setAttribute('data-ui', 'diyalog');
    const dialog = document.createElement('dialog');
    const inDialog = document.createElement('button');
    const outside = document.createElement('button');
    dialog.append(inDialog);
    root.append(dialog, outside);
    document.body.append(root);
    // A closed dialog is not a host (it is not in the top layer).
    expect(floatingRoot(inDialog)).toBe(root);
    dialog.setAttribute('open', '');
    expect(floatingRoot(inDialog)).toBe(dialog);
    expect(floatingRoot(outside)).toBe(root);
    expect(floatingRoot(null)).toBe(document.body);
    root.remove();
  });

  it('a field near the bottom of the window: the list flips above it and stays inside the window', () => {
    const view = { width: 1024, height: 768 };
    // The model field of a dialog sitting low on the screen; the list (capped at 320 px) has 26 px below it.
    const p = place({ top: 690, bottom: 730, left: 300, right: 700 }, { width: 400, height: 320 }, view, {
      align: 'start',
    });
    expect(p.side).toBe('top');
    expect(p.top).toBe(690 - 4 - 320);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left).toBe(300);
    // Room on neither side for all of it: the roomier side, never past the window's edge (inner scroll).
    const tight = place({ top: 300, bottom: 340, left: 300, right: 700 }, { width: 400, height: 900 }, view, {
      align: 'start',
    });
    expect(tight.side).toBe('bottom');
    expect(tight.top + tight.maxHeight).toBeLessThanOrEqual(768 - 8);
  });

  function PickerDialog(props: { readonly onClose: () => void }): ReactNode {
    const [value, setValue] = useState('');
    return (
      <div data-ui="diyalog">
        <button type="button">açan</button>
        <DyDialog open onClose={props.onClose} title="Başka modelle yeniden üret">
          <DyModelPicker
            label="Model"
            runtimes={['codex']}
            value={value}
            catalog={CATALOG}
            onChange={(v) => {
              setValue(v);
            }}
          />
        </DyDialog>
        <output data-testid="value">{value}</output>
      </div>
    );
  }

  it('the model list renders into the dialog (not inside its scrolling content), fixed, flipped up near the bottom', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    const onClose = vi.fn();
    render(<PickerDialog onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Başka modelle yeniden üret' });
    const input = screen.getByRole('combobox', { name: 'Model' });
    const field = input.parentElement as HTMLElement;
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(rect(690, 300, 400, 40));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(320);
    await user.click(input);
    const list = screen.getByRole('listbox', { name: 'Model' });
    // Portalled: a direct child of the (top-layer) dialog, outside the content box and the field's wrapper.
    expect(list.parentElement).toBe(dialog);
    expect(dialog.firstElementChild?.contains(list)).toBe(false);
    expect(field.contains(list)).toBe(false);
    expect(list.style.position).toBe('fixed');
    expect(list.getAttribute('data-side')).toBe('top');
    const top = Number.parseFloat(list.style.top);
    expect(top + 320).toBeLessThanOrEqual(690);
    expect(top).toBeGreaterThanOrEqual(8);
    // At least as wide as the field, starting at its left edge.
    expect(list.style.minWidth).toBe('400px');
    expect(list.style.left).toBe('300px');
    // The combobox keeps its wiring and the focus (inside the dialog).
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);
    // Choosing with the pointer works across the portal (the outside-click check knows the list).
    await user.click(screen.getByTestId('model-option-gpt-c'));
    expect(screen.getByTestId('value').textContent).toBe('gpt-c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes the list first (the dialog stays), the next Escape is left to the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PickerDialog onClose={onClose} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    await user.click(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    // fireEvent returns false when the default (the dialog's cancel) was prevented.
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
    // The browser turns that Escape into `cancel` on the dialog.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click outside the list closes it; the dialog stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PickerDialog onClose={onClose} />);
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('heading', { name: 'Başka modelle yeniden üret' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ 2. motion

function Host(props: { readonly initial?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.initial ?? false);
  return (
    <div data-ui="diyalog">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        aç-kapa
      </button>
      <DyDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Onayla"
        footer={
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            Vazgeç
          </button>
        }
      >
        <input aria-label="alan" />
      </DyDialog>
    </div>
  );
}

describe('dialog enter / exit motion (DyDialog, DyStepUpDialog, motion.css)', () => {
  it('CSS: rises 8 px from 0.98 scale with a backdrop fade; the exit is the reverse and faster; reduced motion is instant', () => {
    expect(tokens).toMatch(/--dy-m-dialog: 200ms;/);
    expect(tokens).toMatch(/--dy-m-dialog-exit: 150ms;/);
    expect(motion).toMatch(
      /dialog\.dy-dialog\[data-state='closed'\] \{\s*opacity: 0;\s*transform: translateY\(8px\) scale\(0\.98\);/,
    );
    expect(motion).toMatch(
      /@starting-style \{\s*\[data-ui='diyalog'\] dialog\.dy-dialog\[open\] \{\s*opacity: 0;\s*transform: translateY\(8px\) scale\(0\.98\);/,
    );
    expect(motion).toMatch(/dialog\.dy-dialog\[data-state='closed'\]::backdrop \{\s*opacity: 0;/);
    expect(motion).toMatch(/@starting-style \{\s*\[data-ui='diyalog'\] dialog\.dy-dialog\[open\]::backdrop/);
    expect(motion).toMatch(/dialog\.dy-dialog \{\s*transition:\s*opacity var\(--dy-m-dialog-exit, 150ms\)/);
    expect(motion).toMatch(
      /dialog\.dy-dialog\[open\]:not\(\[data-state='closed'\]\) \{\s*transition:\s*opacity var\(--dy-m-dialog, 200ms\)/,
    );
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(motion)?.[0] ?? '';
    expect(reduce).toMatch(
      /dialog\.dy-dialog,\s*\[data-ui='diyalog'\] dialog\.dy-dialog::backdrop \{\s*transition: none !important;/,
    );
    expect(motion).toMatch(
      /\[data-motion='reduce'\] dialog\.dy-dialog::backdrop \{\s*transition: none !important;/,
    );
  });

  it('open: modal with data-state="open"; close: stays modal, closed and inert with its content until the exit ends', async () => {
    stubDialogTransition('0.15s');
    const user = userEvent.setup();
    render(<Host />);
    const toggle = screen.getByRole('button', { name: 'aç-kapa' });
    await user.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Onayla' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(dialog.hasAttribute('inert')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(dialog.getAttribute('data-state')).toBe('closed');
    expect(dialog.hasAttribute('inert')).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('Onayla');
    act(() => {
      fireEvent.transitionEnd(dialog);
    });
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(dialog.textContent).toBe('');
    // Focus returns to the opener.
    expect(document.activeElement).toBe(toggle);
  });

  it('a second open during the exit turns the same dialog back (open, not inert, focus inside)', async () => {
    stubDialogTransition('0.15s');
    const user = userEvent.setup();
    render(<Host />);
    const toggle = screen.getByRole('button', { name: 'aç-kapa' });
    await user.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Onayla' });
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(dialog.getAttribute('data-state')).toBe('closed');
    // A browser blurs what was focused in the now inert dialog (jsdom does not: do it by hand); the opener is
    // reached by script here (the page behind is still modal-blocked in a browser, a reopen comes from the app).
    (document.activeElement as HTMLElement | null)?.blur();
    expect(dialog.contains(document.activeElement)).toBe(false);
    act(() => {
      toggle.click();
    });
    expect(screen.getByRole('dialog', { name: 'Onayla' })).toBe(dialog);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The old exit's end does not close the reopened dialog.
    act(() => {
      fireEvent.transitionEnd(dialog);
    });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('open');
  });

  it('reduced motion: the dialog closes in the same commit, even when CSS would transition', async () => {
    stubDialogTransition('0.15s');
    mockMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'aç-kapa' }));
    const dialog = screen.getByRole('dialog', { name: 'Onayla' });
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(dialog.textContent).toBe('');
  });

  it('closing is never held up: without CSS motion (or if transitionend never comes) the dialog still closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubDialogTransition('0.15s');
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      render(<Host />);
      await user.click(screen.getByRole('button', { name: 'aç-kapa' }));
      const dialog = screen.getByRole('dialog', { name: 'Onayla' });
      await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
      expect(dialog.hasAttribute('open')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(dialog.hasAttribute('open')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the step-up dialog: same motion attributes; reopened during its exit it starts clean', async () => {
    stubDialogTransition('0.15s');
    const verify = vi.fn(() => Promise.resolve());
    function StepUpHost(props: { readonly open: boolean }): ReactNode {
      return (
        <div data-ui="diyalog">
          <DyStepUpDialog
            open={props.open}
            verify={verify}
            onVerified={() => undefined}
            onCancel={() => undefined}
          />
        </div>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<StepUpHost open />);
    const dialog = screen.getByTestId('dy-stepup');
    expect(dialog.getAttribute('data-state')).toBe('open');
    const field = screen.getByLabelText(/kod/i);
    await user.type(field, '12');
    rerender(<StepUpHost open={false} />);
    expect(dialog.getAttribute('data-state')).toBe('closed');
    expect(dialog.hasAttribute('inert')).toBe(true);
    rerender(<StepUpHost open />);
    expect(screen.getByTestId('dy-stepup')).toBe(dialog);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(screen.getByLabelText<HTMLInputElement>(/kod/i).value).toBe('');
  });
});
