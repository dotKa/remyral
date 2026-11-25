// p15-form-pattern (docs/design/p15-form-pattern.md): the shared form parts — DyTabs (URL tab, keyboard), the tab form
// (dirty against the loaded value, the sticky bar only while dirty, save / discard, busy, field errors from the
// master's issues, step-up on save, the "Kaydedildi" toast), the unsaved-changes guard (tab switch, in-app link,
// browser unload) and the instant switch (saved at once, undo on a refusal).
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  DyForm,
  DyFormScope,
  DyInstantToggle,
  DyTabs,
  issueText,
  sameValue,
  UnsavedGuardProvider,
  useDyForm,
  useFormSection,
} from '../src/diyalog/formkit';
import { messagesFor } from '@remyral/i18n';
import { toastByTestId } from './toasts';

const tr = messagesFor('tr');

configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface Value {
  readonly name: string;
  readonly limit: string;
}

function NameForm(props: {
  readonly initial: Value;
  readonly save: (v: Value) => Promise<Value | undefined>;
  readonly validate?: (v: Value) => Record<string, string> | null;
}): ReactNode {
  const f = useDyForm<Value>({ initial: props.initial, save: props.save, validate: props.validate });
  if (f.value === null) return null;
  return (
    <DyForm form={f} label="Ad formu" testId="name-form">
      <label>
        Ad
        <input
          aria-invalid={f.fieldError('name') === undefined ? undefined : true}
          value={f.value.name}
          onChange={(e) => {
            f.set({ name: e.target.value });
          }}
        />
      </label>
      {f.fieldError('name') === undefined ? null : <p data-testid="name-error">{f.fieldError('name')}</p>}
      <label>
        Sınır
        <input
          value={f.value.limit}
          onChange={(e) => {
            f.set({ limit: e.target.value });
          }}
        />
      </label>
      {f.fieldError('limit') === undefined ? null : <p data-testid="limit-error">{f.fieldError('limit')}</p>}
      {f.error === null ? null : <p data-testid="form-error">{f.error.message}</p>}
    </DyForm>
  );
}

function Where(): ReactNode {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function TabsPage(props: { readonly save: (v: Value) => Promise<Value | undefined> }): ReactNode {
  return (
    <UnsavedGuardProvider>
      <Link to="/elsewhere">Başka sayfa</Link>
      <DyTabs
        label="Bölümler"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
        ]}
      >
        {(tab) =>
          tab === 'one' ? (
            <NameForm initial={{ name: 'alpha', limit: '3' }} save={props.save} />
          ) : (
            <p data-testid="tab-two">İkinci sekme</p>
          )
        }
      </DyTabs>
      <Where />
    </UnsavedGuardProvider>
  );
}

function renderTabs(save: (v: Value) => Promise<Value | undefined>, path = '/page'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/page" element={<TabsPage save={save} />} />
        <Route
          path="/elsewhere"
          element={
            <>
              <p data-testid="elsewhere">Başka</p>
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DyTabs', () => {
  it('syncs the tab with ?tab=, keeps the first tab as the clean URL and moves with the arrow keys', async () => {
    const user = userEvent.setup();
    renderTabs((v) => Promise.resolve(v), '/page?tab=two');
    expect(screen.getByTestId('tab-two')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'İki' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'Bir' }));
    expect(screen.getByTestId('where').textContent).toBe('/page');
    screen.getByRole('tab', { name: 'Bir' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('where').textContent).toBe('/page?tab=two');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'İki' }));
    await user.keyboard('{Home}');
    expect(screen.getByTestId('where').textContent).toBe('/page');
    // One tab stop.
    expect(screen.getByRole('tab', { name: 'İki' }).getAttribute('tabindex')).toBe('-1');
  });
});

describe('DyForm — dirty tracking, save bar, save, discard', () => {
  it('shows the bar only while the value differs from the loaded one; Vazgeç restores it', async () => {
    const user = userEvent.setup();
    renderTabs((v) => Promise.resolve(v));
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    const name = screen.getByLabelText('Ad');
    await user.type(name, 'x');
    const bar = screen.getByTestId('dy-form-bar');
    expect(within(bar).getByText('Kaydedilmemiş değişiklik var')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Kaydedilmemiş değişiklikler' })).toBeTruthy();
    // Typing it back to the loaded value is not a change.
    await user.type(name, '{Backspace}');
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    await user.type(name, 'yz');
    await user.click(within(screen.getByTestId('dy-form-bar')).getByRole('button', { name: 'Vazgeç' }));
    expect(screen.getByLabelText<HTMLInputElement>('Ad').value).toBe('alpha');
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
  });

  it('saves the value, disables the bar while saving, then hides it and says "Kaydedildi"', async () => {
    const user = userEvent.setup();
    let release: (v: Value) => void = () => undefined;
    const save = vi.fn(
      (v: Value) =>
        new Promise<Value>((resolve) => {
          release = () => {
            resolve({ ...v, name: v.name.trim() });
          };
        }),
    );
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), ' b ');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(save).toHaveBeenCalledWith({ name: 'alpha b ', limit: '3' });
    const busy = screen.getByTestId('dy-form-save');
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.textContent).toContain('Kaydediliyor…');
    expect(screen.getByTestId('dy-form-discard').hasAttribute('disabled')).toBe(true);
    await act(async () => {
      release({ name: 'alpha b ', limit: '3' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    });
    // The saved value is the new baseline (the master trimmed it).
    expect(screen.getByLabelText<HTMLInputElement>('Ad').value).toBe('alpha b');
    // p17-toasts-shortcuts: "Kaydedildi" is a success toast of the shell's toaster (no pill under the form).
    await waitFor(() => {
      expect(toastByTestId('dy-form-saved')?.title).toBe('Kaydedildi');
    });
    expect(toastByTestId('dy-form-saved')?.tone).toBe('success');
    expect(screen.queryByTestId('dy-form-saved')).toBeNull();
  });

  it('Enter in a field saves; ⌘/Ctrl+S saves', async () => {
    const user = userEvent.setup();
    const save = vi.fn((v: Value) => Promise.resolve(v));
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), 'q{Enter}');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await user.type(screen.getByLabelText('Sınır'), '4');
    fireEvent.keyDown(screen.getByLabelText('Sınır'), { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
  });

  it('client checks stop the save and mark the field; master issues land on their fields', async () => {
    const user = userEvent.setup();
    const save = vi.fn((): Promise<Value> =>
      Promise.reject(
        new ApiError(400, 'invalid_request', 'Invalid request.', null, [{ path: 'limit', code: 'too_big' }]),
      ),
    );
    render(
      <MemoryRouter>
        <UnsavedGuardProvider>
          <NameForm
            initial={{ name: 'alpha', limit: '3' }}
            save={save}
            validate={(v) => (v.name.trim() === '' ? { name: 'Ad gerekli.' } : null)}
          />
        </UnsavedGuardProvider>
      </MemoryRouter>,
    );
    await user.clear(screen.getByLabelText('Ad'));
    await user.click(screen.getByTestId('dy-form-save'));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('name-error').textContent).toBe('Ad gerekli.');
    expect(screen.getByTestId('dy-form-failed')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Ad'));
    });
    await user.type(screen.getByLabelText('Ad'), 'beta');
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(screen.getByTestId('limit-error').textContent).toBe(tr.forms.issues.tooBig);
    });
    // A field issue is not repeated as a page error, and the edits stay.
    expect(screen.queryByTestId('form-error')).toBeNull();
    expect(screen.getByTestId('dy-form-bar')).toBeTruthy();
  });

  it('a refusal that is not about a field keeps the edits and shows the error', async () => {
    const user = userEvent.setup();
    const save = vi.fn((): Promise<Value> =>
      Promise.reject(new ApiError(409, 'version_conflict', 'Someone else changed it.')),
    );
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), '!');
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(screen.getByTestId('form-error').textContent).toBe('Someone else changed it.');
    });
    expect(screen.getByLabelText<HTMLInputElement>('Ad').value).toBe('alpha!');
  });
});

describe('Unsaved-changes guard', () => {
  it('asks before another tab: Vazgeç stays, Kaydetmeden çık drops the edits and switches', async () => {
    const user = userEvent.setup();
    const save = vi.fn((v: Value) => Promise.resolve(v));
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), 'x');
    await user.click(screen.getByRole('tab', { name: 'İki' }));
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    expect(within(dialog).getByText('Kaydedilmemiş değişiklikler var')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(screen.queryByText('Kaydedilmemiş değişiklikler var')).toBeNull();
    });
    expect(screen.getByTestId('where').textContent).toBe('/page');
    expect(screen.getByLabelText<HTMLInputElement>('Ad').value).toBe('alphax');

    await user.click(screen.getByRole('tab', { name: 'İki' }));
    await user.click(await screen.findByRole('button', { name: 'Kaydetmeden çık' }));
    await screen.findByTestId('tab-two');
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/page?tab=two');
  });

  it('asks before another tab: Kaydet saves first, then switches', async () => {
    const user = userEvent.setup();
    const save = vi.fn((v: Value) => Promise.resolve(v));
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), 'x');
    screen.getByRole('tab', { name: 'Bir' }).focus();
    await user.keyboard('{ArrowRight}');
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await screen.findByTestId('tab-two');
    expect(save).toHaveBeenCalledWith({ name: 'alphax', limit: '3' });
  });

  it('a failed save in the dialog keeps the page and says so', async () => {
    const user = userEvent.setup();
    const save = vi.fn((): Promise<Value> =>
      Promise.reject(
        new ApiError(400, 'invalid_request', 'Invalid.', null, [{ path: 'name', code: 'required' }]),
      ),
    );
    renderTabs(save);
    await user.type(screen.getByLabelText('Ad'), 'x');
    await user.click(screen.getByRole('tab', { name: 'İki' }));
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await within(dialog).findByTestId('unsaved-failed');
    expect(screen.queryByTestId('tab-two')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/page');
  });

  it('asks before an in-app link; leaving without saving navigates', async () => {
    const user = userEvent.setup();
    renderTabs((v) => Promise.resolve(v));
    await user.type(screen.getByLabelText('Ad'), 'x');
    await user.click(screen.getByRole('link', { name: 'Başka sayfa' }));
    await screen.findByTestId('dy-unsaved-dialog');
    expect(screen.queryByTestId('elsewhere')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Kaydetmeden çık' }));
    await screen.findByTestId('elsewhere');
  });

  it('a clean form never asks (tab switch and link go straight through)', async () => {
    const user = userEvent.setup();
    renderTabs((v) => Promise.resolve(v));
    await user.click(screen.getByRole('tab', { name: 'İki' }));
    await screen.findByTestId('tab-two');
    expect(screen.queryByText('Kaydedilmemiş değişiklikler var')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Başka sayfa' }));
    await screen.findByTestId('elsewhere');
  });

  it('warns on browser unload only while dirty', async () => {
    const user = userEvent.setup();
    renderTabs((v) => Promise.resolve(v));
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.type(screen.getByLabelText('Ad'), 'x');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('A tab form with several sections', () => {
  function Section(props: {
    readonly name: string;
    readonly log: string[];
    readonly fail?: boolean;
  }): ReactNode {
    const [v, setV] = useState('');
    useFormSection({
      dirty: v !== '',
      busy: false,
      save: () => {
        props.log.push(`${props.name}:${v}`);
        if (props.fail === true) return Promise.resolve(false);
        setV('');
        return Promise.resolve(true);
      },
      discard: () => {
        setV('');
      },
    });
    return (
      <label>
        {props.name}
        <input
          value={v}
          onChange={(e) => {
            setV(e.target.value);
          }}
        />
      </label>
    );
  }

  it('one bar saves every dirty section in order and stops at the first failure', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    render(
      <MemoryRouter>
        <UnsavedGuardProvider>
          <DyFormScope label="Politika">
            <Section name="a" log={log} />
            <Section name="b" log={log} fail />
            <Section name="c" log={log} />
          </DyFormScope>
        </UnsavedGuardProvider>
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText('a'), '1');
    await user.type(screen.getByLabelText('c'), '3');
    expect(screen.getAllByTestId('dy-form-bar')).toHaveLength(1);
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(log).toEqual(['a:1', 'c:3']);
    });
    await user.type(screen.getByLabelText('b'), '2');
    await user.type(screen.getByLabelText('c'), '4');
    log.length = 0;
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(log).toEqual(['b:2']);
    });
    expect(screen.getByTestId('dy-form-failed')).toBeTruthy();
    await user.click(screen.getByTestId('dy-form-discard'));
    expect(screen.getByLabelText<HTMLInputElement>('b').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('c').value).toBe('');
  });
});

describe('DyInstantToggle', () => {
  it('applies at once and says "Kaydedildi ✓"', async () => {
    const user = userEvent.setup();
    const commit = vi.fn((_v: boolean) => Promise.resolve());
    function Host(): ReactNode {
      const [on, setOn] = useState(false);
      return (
        <DyInstantToggle
          label="Sohbetleri dizinle"
          checked={on}
          testId="idx"
          onCommit={async (v) => {
            await commit(v);
            setOn(v);
          }}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('switch', { name: 'Sohbetleri dizinle' }));
    expect(commit).toHaveBeenCalledWith(true);
    // p17-toasts-shortcuts: the confirmation is a toast; "Kaydediliyor…" is the only inline state.
    await waitFor(() => {
      expect(toastByTestId('instant-saved')?.title).toBe('Kaydedildi ✓');
    });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('moves back and shows why when the master refuses (undo on error)', async () => {
    const user = userEvent.setup();
    let reject: (e: unknown) => void = () => undefined;
    render(
      <DyInstantToggle
        label="Paylaş"
        checked={false}
        testId="share"
        onCommit={() =>
          new Promise<void>((_, rj) => {
            reject = rj;
          })
        }
      />,
    );
    await user.click(screen.getByRole('switch', { name: 'Paylaş' }));
    // Optimistic: it moved at once.
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      reject(new ApiError(409, 'version_conflict', 'Changed elsewhere.'));
      await Promise.resolve();
    });
    await screen.findByTestId('instant-undone');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('instant-undone').textContent).toContain('Değişiklik geri alındı.');
    expect(screen.getByTestId('api-error').textContent).toContain('Changed elsewhere.');
  });
});

describe('helpers', () => {
  it('compares plain values structurally and words master issue codes', () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue(['x'], ['y'])).toBe(false);
    const t = tr.forms.issues;
    expect(issueText(t, 'too_small')).toBe(t.tooSmall);
    expect(issueText(t, 'invalid_url')).toBe(t.invalid);
    expect(issueText(t, 'weird')).toBe(t.other({ code: 'weird' }));
  });
});
