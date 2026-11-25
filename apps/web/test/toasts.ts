import { waitFor } from '@testing-library/react';
import { getToasts, type Toast } from '../src/diyalog/toast/store';

/**
 * p17-toasts-shortcuts: what the toast queue holds — for tests that render a component without the shell's toaster —
 * and the toast elements of a full-app render (the shell mounts `DyToaster`). The live regions repeat a toast's
 * text for screen readers, so a plain `getByText` would find two elements: look for the toast itself.
 */
export function openToasts(): readonly Toast[] {
  return getToasts().filter((t) => t.open);
}

/** The open toast with this test id, if any. */
export function toastByTestId(testId: string): Toast | undefined {
  return openToasts().find((t) => t.testId === testId);
}

function matches(text: string, want: string | RegExp): boolean {
  return typeof want === 'string' ? text === want : want.test(text);
}

/** The toast element (in the DOM) whose title is `title`, waiting for it. */
export async function findToast(title: string | RegExp): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    const li = [...document.querySelectorAll<HTMLElement>('li[data-toast]')].find((el) =>
      matches(el.querySelector('[data-toast-title]')?.textContent ?? '', title),
    );
    if (li === undefined) throw new Error(`no toast "${String(title)}"`);
    found = li;
  });
  return found as unknown as HTMLElement;
}
