import { fill } from '@remyral/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import {
  addShare,
  listShares,
  removeShare,
  searchShareUsers,
  type ShareEntry,
  type ShareUser,
  transferThread,
} from '../../api/chatComplete';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { DyDialog } from '../DyDialog';
import { DyCheck } from '../forms';
import { DyIcon } from '../icons';
import { DyButton, DySearch } from '../screens/parts';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §4): share a conversation read-only with other users (they find
 * it under "Paylaşılanlar"; cards and links open with their own permissions) and hand it over to another user. Both
 * are the owner's, CSRF-protected and audited on the master.
 */

/** Matching users for a typed name (debounced; never the caller — the master leaves them out). */
function useUserSearch(q: string): { users: readonly ShareUser[]; error: string | null } {
  const sayError = useErrorText();
  const [users, setUsers] = useState<readonly ShareUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      searchShareUsers(q.trim()).then(
        (u) => {
          if (!live) return;
          setUsers(u);
          setError(null);
        },
        (err: unknown) => {
          if (live) setError(sayError(err));
        },
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [q, sayError]);
  return { users, error };
}

export function ShareDialog(props: {
  readonly open: boolean;
  readonly threadId: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().chatComplete.share;
  const sayError = useErrorText();
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<readonly ShareEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useUserSearch(q);
  const { open, threadId } = props;
  useEffect(() => {
    if (!open) return;
    let live = true;
    listShares(threadId).then(
      (e) => {
        if (live) setEntries(e);
      },
      (err: unknown) => {
        if (live) setError(fill(t.failed, { error: sayError(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [open, threadId, t, sayError]);
  const run = async (key: string, fn: () => Promise<readonly ShareEntry[]>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      setEntries(await fn());
    } catch (err) {
      setError(fill(t.failed, { error: sayError(err) }));
    } finally {
      setBusy(null);
    }
  };
  const shared = new Set((entries ?? []).map((e) => e.userId));
  const candidates = search.users.filter((u) => !shared.has(u.id));
  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={t.title}
      description={t.body}
      testId="share-dialog"
      footer={<DyButton onClick={props.onClose}>{t.close}</DyButton>}
    >
      <div className="grid gap-3">
        <section>
          <h3 className="m-0 mb-1 text-[0.8125rem] font-bold">{t.readers}</h3>
          {entries === null ? null : entries.length === 0 ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{t.none}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="share-readers">
              {entries.map((e) => (
                <li key={e.userId} className="flex items-center gap-2 text-[0.875rem]">
                  <span className="min-w-0 flex-1 truncate">{e.username}</span>
                  <button
                    type="button"
                    aria-label={fill(t.remove, { name: e.username })}
                    disabled={busy !== null}
                    onClick={() => {
                      void run(`rm:${e.userId}`, async () => {
                        await removeShare(threadId, e.userId);
                        return entries.filter((x) => x.userId !== e.userId);
                      });
                    }}
                    className="dy-press grid size-9 place-items-center rounded-[9px] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-red-ink"
                  >
                    <DyIcon name="xc" className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <DySearch label={t.search} value={q} onChange={setQ} />
        {search.error === null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-red-ink">{search.error}</p>
        )}
        {candidates.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noMatch}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="share-candidates">
            {candidates.map((u) => (
              <li key={u.id} className="flex items-center gap-2 text-[0.875rem]">
                <span className="min-w-0 flex-1 truncate">{u.username}</span>
                <DyButton
                  busy={busy === `add:${u.id}`}
                  disabled={busy !== null}
                  onClick={() => {
                    void run(`add:${u.id}`, () => addShare(threadId, u.id));
                  }}
                >
                  {t.add}
                </DyButton>
              </li>
            ))}
          </ul>
        )}
        {error === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {error}
          </p>
        )}
      </div>
    </DyDialog>
  );
}

export function TransferDialog(props: {
  readonly open: boolean;
  readonly threadId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const t = useT().chatComplete.transfer;
  const ts = useT().chatComplete.share;
  const sayError = useErrorText();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<ShareUser | null>(null);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useUserSearch(q);
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      size="sm"
      title={t.title}
      description={t.body}
      testId="transfer-dialog"
      footer={
        <DyButton
          variant="warn"
          busy={busy}
          disabled={picked === null}
          data-testid="transfer-submit"
          onClick={() => {
            if (picked === null) return;
            setBusy(true);
            setError(null);
            transferThread(props.threadId, picked.id, keep).then(
              () => {
                setBusy(false);
                props.onDone();
              },
              (err: unknown) => {
                setBusy(false);
                setError(fill(t.failed, { error: sayError(err) }));
              },
            );
          }}
        >
          {t.submit}
        </DyButton>
      }
    >
      <div className="grid gap-3">
        <DySearch label={t.pick} value={q} onChange={setQ} />
        {search.users.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{ts.noMatch}</p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0"
            data-testid="transfer-candidates"
            role="radiogroup"
          >
            {search.users.map((u) => (
              <li key={u.id}>
                <label className="flex min-h-9 items-center gap-2 text-[0.875rem]">
                  <input
                    type="radio"
                    name="transfer-target"
                    checked={picked?.id === u.id}
                    onChange={() => {
                      setPicked(u);
                    }}
                  />
                  {u.username}
                </label>
              </li>
            ))}
          </ul>
        )}
        <DyCheck label={t.keep} checked={keep} onChange={setKeep} />
        {error === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {error}
          </p>
        )}
      </div>
    </DyDialog>
  );
}
