import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getProjectIdeExtensionPolicy,
  type IdeAllowedExtension,
  type IdeProjectExtensionPolicy,
  listIdeExtensions,
  putProjectIdeExtensionPolicy,
} from '../../../../api/ideExtensions';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { useCardForm, useSectionSave } from '../../../formkit';
import { DyTextarea } from '../../kit';
import { DyButton, Panel } from '../../parts';
import { LoadState, SaveResult } from './policy-common';

type Mark = 'none' | 'required' | 'recommended' | 'deny';

interface Draft {
  readonly marks: Readonly<Record<string, Mark>>;
  readonly enforced: string;
}

function draftOf(p: IdeProjectExtensionPolicy, list: readonly IdeAllowedExtension[]): Draft {
  const marks: Record<string, Mark> = {};
  for (const e of list) marks[e.id] = 'none';
  for (const id of p.required) marks[id] = 'required';
  for (const id of p.recommended) marks[id] = 'recommended';
  for (const id of p.deny) marks[id] = 'deny';
  return {
    marks,
    enforced: Object.keys(p.enforcedSettings).length === 0 ? '' : JSON.stringify(p.enforcedSettings, null, 2),
  };
}

const same = (a: Draft, b: Draft): boolean =>
  a.enforced.trim() === b.enforced.trim() &&
  Object.keys({ ...a.marks, ...b.marks }).every((k) => (a.marks[k] ?? 'none') === (b.marks[k] ?? 'none'));

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): Projeler → Politika → "IDE eklentileri" — per allowed extension: required
 * (installed at every Tam IDE start of the project; users cannot remove it), recommended (offered in the user's
 * picker) or denied here; plus enforced settings (JSON, written as machine settings at start — presentation, a
 * folder's `.vscode/settings.json` still wins). Owners / admins edit (step-up `extensions.ide`); everyone else reads.
 */
export function IdeExtensionsPolicyPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().ide.projectPolicy;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project, canEdit } = props;
  const [policy, setPolicy] = useState<IdeProjectExtensionPolicy | null>(null);
  const [list, setList] = useState<readonly IdeAllowedExtension[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      const p = await getProjectIdeExtensionPolicy(project);
      // The allowlist is an admin read; others see the project's ids only.
      const l = canEdit ? await listIdeExtensions() : [];
      setPolicy(p);
      setList(l);
      setDraft(draftOf(p, l));
    });
  }, [run, project, canEdit]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const base = policy === null ? null : draftOf(policy, list);
  const save = (): Promise<boolean> => {
    setDone(null);
    setJsonError(null);
    const d = draft;
    if (d === null) return Promise.resolve(false);
    let enforced: Record<string, unknown> = {};
    if (d.enforced.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(d.enforced);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object');
        enforced = parsed as Record<string, unknown>;
      } catch {
        setJsonError(t.enforcedInvalid);
        return Promise.resolve(false);
      }
    }
    const of = (m: Mark): string[] => Object.keys(d.marks).filter((k) => d.marks[k] === m);
    return sectionSave(
      saver,
      async () => {
        const p = await putProjectIdeExtensionPolicy(project, {
          required: of('required'),
          recommended: of('recommended'),
          deny: of('deny'),
          enforcedSettings: enforced,
        });
        setPolicy(p);
        setDraft(draftOf(p, list));
        setDone(t.saved);
      },
      t.stepUp,
    );
  };
  const card = useCardForm({
    dirty: canEdit && draft !== null && base !== null && !same(draft, base),
    busy: saver.busy,
    save,
    discard: () => {
      if (base !== null) setDraft(base);
    },
  });
  const ids = draft === null ? [] : Object.keys(draft.marks).sort();
  const nameOf = (id: string): string => list.find((e) => e.id === id)?.displayName ?? id;

  return (
    <Panel title={t.title} sub={t.sub} testId="ide-ext-project-policy">
      <div className="flex flex-col gap-3">
        <LoadState loaded={draft !== null} error={loader.error} what={t.loading} onRetry={refresh} />
        {draft === null ? null : (
          <>
            {ids.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.empty}</p>
            ) : (
              <ul className="grid gap-1.5" aria-label={t.title}>
                {ids.map((id) => (
                  <li
                    key={id}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="ide-ext-project-row"
                  >
                    <span className="font-bold">{nameOf(id)}</span>
                    <span className="font-dy-mono text-[0.75rem] text-dy-muted">{id}</span>
                    <select
                      className="ml-auto rounded-[8px] border border-dy-line bg-dy-card px-2 py-1 text-[0.8125rem]"
                      aria-label={t.markLabel({ id })}
                      value={draft.marks[id] ?? 'none'}
                      disabled={!canEdit || saver.busy}
                      onChange={(e) => {
                        setDraft({ ...draft, marks: { ...draft.marks, [id]: e.target.value as Mark } });
                      }}
                      data-testid={`ide-ext-mark-${id}`}
                    >
                      <option value="none">{t.marks.none}</option>
                      <option value="required">{t.marks.required}</option>
                      <option value="recommended">{t.marks.recommended}</option>
                      <option value="deny">{t.marks.deny}</option>
                    </select>
                  </li>
                ))}
              </ul>
            )}
            <DyTextarea
              label={t.enforced}
              hint={t.enforcedHint}
              rows={5}
              value={draft.enforced}
              readOnly={!canEdit}
              error={jsonError}
              className="font-dy-mono"
              onChange={(e) => {
                setDraft({ ...draft, enforced: e.target.value });
              }}
              data-testid="ide-ext-enforced"
            />
            {canEdit && !card.inScope ? (
              <div>
                <DyButton variant="primary" icon="key" busy={saver.busy} onClick={card.submit}>
                  {t.save}
                </DyButton>
              </div>
            ) : null}
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
