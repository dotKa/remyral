import { type ReactNode, useEffect, useId, useState } from 'react';
import type { ChatThread } from '../../api/chat';
import {
  type ChatGroup,
  type ChatTag,
  createGroup,
  createTag,
  deleteTag,
  moveThreadToGroup,
  setThreadTags,
  TAG_COLORS,
  type TagColor,
  updateGroup,
  updateTag,
} from '../../api/chatOrganize';
import type { ApiError } from '../../api/client';
import { cx, toApiError } from '../../components/ui';
import { TagDot } from '../../screens/chat/organize/tags';
import { DyConfirmDialog } from '../common/actions';
import { DyDialog } from '../DyDialog';
import { DyErrorNotice, DyField } from '../forms';
import { DyButton } from '../screens/parts';
import { useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog-w4: the conversation organize dialogs of the Sohbet list in the Diyalog language — "Gruba taşı…" (with
 * create and move), "Etiketler…" of one conversation (with a new tag), naming a group (new / rename) and managing tags
 * (rename, recolour, delete with an in-row confirmation). Same calls and behaviour as the classic dialogs
 * (screens/chat/organize/OrganizeDialogs.tsx); large tap targets (phones use these instead of drag and drop). A tag's
 * colour is a closed palette name (never free CSS from the server) and always comes with the tag's name.
 */

const OPTION =
  'flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 text-left text-[0.9375rem] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-dy-teal sm:min-h-10';
const OPTION_ON = 'border-dy-teal bg-dy-teal-soft/60';
const OPTION_OFF = 'border-dy-line-2 bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink';

/** The tag palette as a radio group: a dot and a colour name per option (arrows move within the group). */
export function DyColorPicker(props: {
  readonly value: TagColor;
  readonly onChange: (c: TagColor) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}): ReactNode {
  const name = useId();
  const o = useT().chat.organize;
  return (
    <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0" disabled={props.disabled}>
      <legend className="mb-1.5 p-0 text-[0.875rem] font-bold">{props.label ?? o.color}</legend>
      <div className="flex flex-wrap gap-1.5">
        {TAG_COLORS.map((c) => (
          <label
            key={c}
            className={cx(
              'inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[9px] border px-2.5 text-[0.8125rem] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-dy-teal sm:min-h-8',
              props.value === c ? 'border-dy-teal bg-dy-teal-soft/60 font-bold' : OPTION_OFF,
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={c}
              checked={props.value === c}
              onChange={() => {
                props.onChange(c);
              }}
            />
            <TagDot color={c} />
            {o.colors[c]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DyMoveToGroupDialog(props: {
  readonly thread: ChatThread | null;
  readonly groups: readonly ChatGroup[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const t = props.thread;
  const tc = useT().chat;
  const o = tc.organize;
  const name = useId();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    setError(null);
    setNewName('');
  }, [t?.id]);
  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onDone();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  const current = t?.groupId ?? null;
  return (
    <DyDialog
      open={t !== null}
      onClose={props.onClose}
      title={o.moveTitle}
      description={t === null ? undefined : o.moveQuestion({ title: t.title })}
      size="sm"
      testId="dy-move-dialog"
    >
      <fieldset className="m-0 grid gap-1.5 border-0 p-0" disabled={busy}>
        <legend className="sr-only">{o.groupOf({ title: t?.title ?? tc.title })}</legend>
        {[{ id: null, name: o.noGroup }, ...props.groups].map((g) => (
          <label key={g.id ?? 'none'} className={cx(OPTION, g.id === current ? OPTION_ON : OPTION_OFF)}>
            <input
              type="radio"
              name={name}
              className="size-4 accent-[var(--dy-teal)]"
              checked={g.id === current}
              onChange={() => {
                if (t !== null) void run(() => moveThreadToGroup(t.id, g.id));
              }}
            />
            <span className="min-w-0 truncate">{g.name}</span>
          </label>
        ))}
      </fieldset>
      <form
        className="grid gap-2 border-t border-dy-line pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (n === '' || t === null) return;
          void run(async () => {
            const g = await createGroup(n);
            await moveThreadToGroup(t.id, g.id);
          });
        }}
      >
        <DyField
          label={o.newGroup}
          value={newName}
          maxLength={60}
          placeholder={o.newGroupExample}
          onChange={(e) => {
            setNewName(e.target.value);
          }}
        />
        <DyButton type="submit" busy={busy} disabled={newName.trim() === ''}>
          {o.createAndMove}
        </DyButton>
      </form>
      <DyErrorNotice error={error} retryLeft={0} />
    </DyDialog>
  );
}

export function DyThreadTagsDialog(props: {
  readonly thread: ChatThread | null;
  readonly tags: readonly ChatTag[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const t = props.thread;
  const tc = useT().chat;
  const o = tc.organize;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState<ChatTag[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColor>('blue');
  useEffect(() => {
    setSelected(new Set(t?.tagIds ?? []));
    setExtra([]);
    setError(null);
    setNewName('');
  }, [t?.id, t?.tagIds]);
  const all = [...props.tags, ...extra.filter((e) => !props.tags.some((x) => x.id === e.id))];
  async function create(): Promise<void> {
    const n = newName.trim();
    if (n === '') return;
    setBusy(true);
    setError(null);
    try {
      const tag = await createTag(n, newColor);
      setExtra((x) => [...x, tag]);
      setSelected((s) => new Set([...s, tag.id]));
      setNewName('');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  async function save(): Promise<void> {
    if (t === null) return;
    setBusy(true);
    setError(null);
    try {
      await setThreadTags(t.id, [...selected]);
      props.onDone();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DyDialog
      open={t !== null}
      onClose={props.onClose}
      title={o.tagsTitle}
      description={t === null ? undefined : o.tagsOf({ title: t.title })}
      size="sm"
      testId="dy-tags-dialog"
      footer={
        <>
          <DyButton onClick={props.onClose}>{tc.cancel}</DyButton>
          <DyButton variant="primary" busy={busy} onClick={() => void save()}>
            {o.saveTags}
          </DyButton>
        </>
      }
    >
      {all.length === 0 ? <p className="m-0 text-[0.875rem] text-dy-muted">{o.noTagsYet}</p> : null}
      <fieldset className="m-0 grid gap-1.5 border-0 p-0" disabled={busy}>
        <legend className="sr-only">{o.tagsTitle}</legend>
        {all.map((tag) => {
          const on = selected.has(tag.id);
          return (
            <label key={tag.id} className={cx(OPTION, on ? OPTION_ON : OPTION_OFF)}>
              <input
                type="checkbox"
                className="size-4 accent-[var(--dy-teal)]"
                checked={on}
                onChange={(e) => {
                  const add = e.target.checked;
                  setSelected((s) => {
                    const n = new Set(s);
                    if (add) n.add(tag.id);
                    else n.delete(tag.id);
                    return n;
                  });
                }}
              />
              <TagDot color={tag.color} />
              <span className="min-w-0 truncate">{tag.name}</span>
            </label>
          );
        })}
      </fieldset>
      <form
        className="grid gap-2.5 border-t border-dy-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <DyField
          label={o.newTag}
          value={newName}
          maxLength={40}
          placeholder={o.newTagExample}
          onChange={(e) => {
            setNewName(e.target.value);
          }}
        />
        <DyColorPicker value={newColor} onChange={setNewColor} disabled={busy} />
        <div>
          <DyButton type="submit" icon="plus" busy={busy} disabled={newName.trim() === ''}>
            {o.createTag}
          </DyButton>
        </div>
      </form>
      <DyErrorNotice error={error} retryLeft={0} />
    </DyDialog>
  );
}

/** New group (group null) or rename. */
export function DyGroupNameDialog(props: {
  readonly open: boolean;
  readonly group: ChatGroup | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const tc = useT().chat;
  const o = tc.organize;
  const [name, setName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(props.group?.name ?? '');
    setError(null);
  }, [props.open, props.group]);
  async function save(): Promise<void> {
    const n = name.trim();
    if (n === '') return;
    setBusy(true);
    setError(null);
    try {
      if (props.group === null) await createGroup(n);
      else await updateGroup(props.group.id, { name: n });
      props.onDone();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={props.group === null ? o.newGroup : o.renameGroup}
      size="sm"
      testId="dy-group-dialog"
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DyField
          label={o.groupName}
          value={name}
          maxLength={60}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <DyErrorNotice error={error} retryLeft={0} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <DyButton onClick={props.onClose}>{tc.cancel}</DyButton>
          <DyButton type="submit" variant="primary" busy={busy} disabled={name.trim() === ''}>
            {props.group === null ? o.createGroup : tc.save}
          </DyButton>
        </div>
      </form>
    </DyDialog>
  );
}

function TagRow(props: { readonly tag: ChatTag; readonly onChanged: () => void }): ReactNode {
  const tc = useT().chat;
  const o = tc.organize;
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(props.tag.name);
  const [color, setColor] = useState<TagColor>(props.tag.color);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setConfirm(false);
      props.onChanged();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li
      className="grid gap-2 rounded-[12px] border border-dy-line bg-dy-card px-3 py-2"
      data-testid="manage-tag"
    >
      {editing ? (
        <form
          className="grid gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => updateTag(props.tag.id, { name: name.trim(), color }));
          }}
        >
          <DyField
            label={o.tagName}
            value={name}
            maxLength={40}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <DyColorPicker value={color} onChange={setColor} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <DyButton type="submit" variant="primary" busy={busy} disabled={name.trim() === ''}>
              {tc.save}
            </DyButton>
            <DyButton
              onClick={() => {
                setEditing(false);
                setName(props.tag.name);
                setColor(props.tag.color);
              }}
            >
              {tc.cancel}
            </DyButton>
          </div>
        </form>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          <TagDot color={props.tag.color} />
          <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">{props.tag.name}</span>
          <span
            className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums"
            aria-label={o.inChats({ n: props.tag.threadCount })}
          >
            {props.tag.threadCount}
          </span>
          <span className="flex items-center gap-0.5">
            <DyButton
              variant="ghost"
              aria-label={o.editTagLabel({ name: props.tag.name })}
              onClick={() => {
                setEditing(true);
              }}
            >
              {o.edit}
            </DyButton>
            <DyButton
              variant="ghost"
              aria-label={o.deleteTagLabel({ name: props.tag.name })}
              onClick={() => {
                setConfirm(true);
              }}
            >
              {tc.delete}
            </DyButton>
          </span>
          <DyConfirmDialog
            open={confirm}
            onClose={() => {
              setConfirm(false);
            }}
            title={o.confirmDelete}
            confirmLabel={o.deleteTag({ name: props.tag.name })}
            cancelLabel={o.keep}
            busy={busy}
            testId="manage-tag-confirm"
            onConfirm={() => {
              setConfirm(false);
              void run(() => deleteTag(props.tag.id));
            }}
          />
        </div>
      )}
      <DyErrorNotice error={error} retryLeft={0} />
    </li>
  );
}

export function DyManageTagsDialog(props: {
  readonly open: boolean;
  readonly tags: readonly ChatTag[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): ReactNode {
  const o = useT().chat.organize;
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('blue');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  async function create(): Promise<void> {
    const n = name.trim();
    if (n === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTag(n, color);
      setName('');
      props.onChanged();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={o.manageTitle}
      description={o.manageHint}
      testId="dy-manage-tags-dialog"
      footer={
        <DyButton variant="primary" className="col-span-2" onClick={props.onClose}>
          {o.done}
        </DyButton>
      }
    >
      {props.tags.length === 0 ? <p className="m-0 text-[0.875rem] text-dy-muted">{o.noTags}</p> : null}
      <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={o.yourTags}>
        {props.tags.map((t) => (
          <TagRow key={`${t.id}:${t.name}:${t.color}`} tag={t} onChanged={props.onChanged} />
        ))}
      </ul>
      <form
        className="grid gap-2.5 border-t border-dy-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <DyField
          label={o.newTag}
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <DyColorPicker value={color} onChange={setColor} disabled={busy} />
        <div>
          <DyButton type="submit" icon="plus" busy={busy} disabled={name.trim() === ''}>
            {o.createTag}
          </DyButton>
        </div>
      </form>
      <DyErrorNotice error={error} retryLeft={0} />
    </DyDialog>
  );
}
