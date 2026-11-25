import { type ReactNode, type SubmitEvent, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { createNoteCard, type NoteCard, updateNoteCard } from '../../../api/outputs';
import { toApiError } from '../../../components/ui';
import { parseLinks, parseTagText } from '../../../screens/outputs/format';
import { DyApiError, DyCheck, DyInput, DyNotice, DyTextarea } from '../kit';
import { DyButton } from '../parts';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2: create or edit a note card (title, Markdown body, tags, https links, pin) — the classic
 * `NoteCardForm` rules (https-only links, tag parsing) and calls in the Diyalog language. Notes are not context
 * documents: agents never receive them.
 */
export function NoteForm(props: {
  readonly project: string;
  readonly initial?: NoteCard;
  readonly onSaved: (card: NoteCard) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().outputs;
  const init = props.initial;
  const [title, setTitle] = useState(init?.title ?? '');
  const [body, setBody] = useState(init?.body ?? '');
  const [tags, setTags] = useState(init?.tags.join(', ') ?? '');
  const [links, setLinks] = useState(init?.links.join('\n') ?? '');
  const [pinned, setPinned] = useState(init?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = parseLinks(links);
    if (parsed.bad !== null) {
      setLinkError(t.note.badLink({ link: parsed.bad }));
      return;
    }
    setLinkError(null);
    setBusy(true);
    setError(null);
    const input = { title: title.trim(), body, tags: parseTagText(tags), links: parsed.links, pinned };
    try {
      props.onSaved(
        init === undefined
          ? await createNoteCard(props.project, input)
          : await updateNoteCard(init.id, input),
      );
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} aria-label={t.note.label}>
      <DyInput
        label={t.note.title}
        required
        maxLength={200}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
        }}
      />
      <DyTextarea
        label={t.note.body}
        rows={8}
        maxLength={20_000}
        value={body}
        placeholder={t.note.bodyPlaceholder}
        onChange={(e) => {
          setBody(e.target.value);
        }}
      />
      <DyInput
        label={t.tags}
        hint={t.tagsHint}
        value={tags}
        onChange={(e) => {
          setTags(e.target.value);
        }}
      />
      <DyTextarea
        label={t.note.links}
        rows={3}
        value={links}
        placeholder={t.note.linksPlaceholder}
        error={linkError}
        className="font-dy-mono"
        onChange={(e) => {
          setLinks(e.target.value);
        }}
      />
      <DyCheck label={t.pinTop} checked={pinned} onChange={setPinned} />
      <DyNotice tone="neutral">{t.note.private}</DyNotice>
      <DyApiError error={error} />
      <div className="flex flex-wrap gap-2">
        <DyButton type="submit" variant="primary" busy={busy} disabled={title.trim() === ''}>
          {init === undefined ? t.note.create : t.note.save}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </div>
    </form>
  );
}
