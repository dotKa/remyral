import { type ReactNode, useState } from 'react';
import { appConnections, type GitHubStatus, startGitHubConnect } from '../../../api/github';
import type { Navigate } from '../../../screens/integrationsPaths';
import { useSubmit } from '../../../screens/useSubmit';
import { useT } from '../../../i18n/I18nProvider';
import { DyApiError, DyDetails, DyField, DyNotice, FormActions } from '../forms';
import { DyButton } from '../parts';
import { useGuardedOp } from './integrations-ops';
import { GitHubAppCard, needsAttention, type RemovedApp } from './integrations-github-app';

/**
 * p17-chat-github Part 3 (docs/design/p17-chat-github.md §3) and p17-github-apps-ui: the "GitHub App'leri" list in
 * Ayarlar → Entegrasyonlar → GitHub — every App connection (one private App per account / organization; a private
 * App can only be installed on the account that owns it) is a peer card ({@link GitHubAppCard}); the first one is not
 * set apart any more. Under the list "App ekle" (the manifest flow for an organization or an account) and a short
 * guide.
 */

/** The short guide: why one private App per account / organization, the steps, and why not a public App. */
export function GitHubConnectionsGuide(): ReactNode {
  const t = useT().chatGithub.connections;
  return (
    <DyDetails summary={t.guideSummary} testId="github-connections-guide">
      <div className="flex flex-col gap-2 text-[0.875rem]">
        <p className="m-0">{t.guideWhy}</p>
        <ol className="m-0 flex flex-col gap-1 pl-5">
          {[t.guideSteps.s1, t.guideSteps.s2, t.guideSteps.s3].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="m-0 text-dy-muted">{t.guidePublic}</p>
      </div>
    </DyDetails>
  );
}

function AddConnection(props: { readonly status: GitHubStatus; readonly navigate: Navigate }): ReactNode {
  const t = useT().chatGithub.connections;
  const tg = useT().integrations.github;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<'user' | 'organization'>('organization');
  const [org, setOrg] = useState('');
  const [label, setLabel] = useState('');
  const act = useSubmit();
  const guarded = useGuardedOp();
  const panelCount = appConnections(props.status).filter((c) => c.source === 'panel').length;
  const full = panelCount >= props.status.maxConnections;
  if (!props.status.available) return null;
  if (!open)
    return (
      <div className="flex flex-col gap-1">
        <div>
          <DyButton
            icon="plus"
            disabled={full}
            onClick={() => {
              setOpen(true);
            }}
          >
            {t.add}
          </DyButton>
        </div>
        {full ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.limit({ n: props.status.maxConnections })}</p>
        ) : null}
      </div>
    );
  return (
    <form
      aria-label={t.addTitle}
      className="flex flex-col gap-3 rounded-[10px] border border-dy-line p-3"
      data-testid="github-connection-add"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const res = await guarded(
            () =>
              startGitHubConnect(
                target === 'user' ? { kind: 'user' } : { kind: 'organization', organization: org.trim() },
                {},
                label,
              ),
            t.stepUpAdd,
          );
          if (res !== null) props.navigate(res.formUrl);
        });
      }}
    >
      <h3 className="m-0 text-[0.9375rem] font-bold">{t.addTitle}</h3>
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="mb-0.5 text-[0.8125rem] font-bold">{tg.whereLegend}</legend>
        {(
          [
            ['organization', tg.whereOrg],
            ['user', tg.whereUser],
          ] as const
        ).map(([v, l]) => (
          <label key={v} className="flex min-h-11 items-center gap-2.5 md:min-h-8">
            <input
              type="radio"
              name="dy-github-add-target"
              className="size-4 accent-[var(--dy-teal)]"
              checked={target === v}
              onChange={() => {
                setTarget(v);
              }}
            />
            {l}
          </label>
        ))}
      </fieldset>
      {target === 'organization' ? (
        <DyField
          label={tg.organization}
          value={org}
          placeholder="acme" // i18n-ignore: product name or example value
          spellCheck={false}
          autoComplete="off"
          mono
          hint={tg.orgHint}
          onChange={setOrg}
        />
      ) : null}
      <DyField label={t.labelOptional} value={label} maxLength={60} onChange={setLabel} />
      <FormActions>
        <DyButton
          type="submit"
          variant="primary"
          busy={act.busy}
          disabled={target === 'organization' && org.trim() === ''}
        >
          {tg.connect}
        </DyButton>
        <DyButton
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t.cancel}
        </DyButton>
      </FormActions>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </form>
  );
}

/** Every App as the same card, then "App ekle" and the guide. */
export function GitHubAppsSection(props: {
  readonly status: GitHubStatus;
  readonly onStatus: (s: GitHubStatus) => void;
  readonly onRemoved: (removed: RemovedApp) => void;
  readonly navigate: Navigate;
}): ReactNode {
  const t = useT().chatGithub.connections;
  const tg = useT().integrations.github;
  const apps = appConnections(props.status);
  const many = apps.length > 1;
  return (
    <section aria-label={t.title} className="flex flex-col gap-3" data-testid="github-connections">
      <p className="m-0 max-w-[68ch] text-[0.875rem] text-dy-muted">{t.sub}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {apps.map((c) => (
          <GitHubAppCard
            key={c.keyRef}
            status={props.status}
            connection={c}
            many={many}
            defaultOpen={!many || needsAttention(c)}
            onStatus={props.onStatus}
            onRemoved={props.onRemoved}
          />
        ))}
      </ul>
      <div className="flex flex-col gap-2 border-t border-dy-line pt-3">
        {props.status.available ? (
          <AddConnection status={props.status} navigate={props.navigate} />
        ) : (
          <DyNotice tone="amber" title={tg.noOriginTitle}>
            {tg.noOriginBody}
          </DyNotice>
        )}
        <GitHubConnectionsGuide />
      </div>
    </section>
  );
}
