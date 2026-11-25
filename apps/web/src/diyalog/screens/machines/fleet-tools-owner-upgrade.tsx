import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import {
  confirmOwnerUpgrade,
  listOwnerUpgrades,
  type OwnerUpgrade,
  rollbackOwnerUpgrade,
  startOwnerUpgrade,
} from '../../../api/updateChannel';
import { useAuth } from '../../../auth/AuthProvider';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyApiError } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows } from '../parts';

/**
 * p17-update-channel: Araçlar ve sürümler → "Belirli bir sürüme yükselt". The owner names a
 * runtime / tool and an exact upstream version; the master resolves it from the official source with its published
 * integrity (or refuses), installs it on the canary machines first, and on "Onayla" rolls it out and writes the runtime
 * policy version; "Geri al" restores the previous one.
 */

const ITEMS: readonly (readonly [string, 'runtime' | 'tool'])[] = [
  ['claude-code', 'runtime'],
  ['codex', 'runtime'],
  ['pi', 'runtime'],
  ['opencode', 'runtime'],
  ['git', 'tool'],
  ['uv', 'tool'],
  ['cloudflared', 'tool'],
  ['ffmpeg', 'tool'],
];

export function OwnerUpgradePanel(): ReactNode {
  const t = useT().updateChannel;
  const { state } = useAuth();
  const owner = state.kind === 'signedIn' && state.user.role === 'owner';
  const stepUp = useStepUp();
  const act = useSubmit();
  const [list, setList] = useState<OwnerUpgrade[]>([]);
  const [item, setItem] = useState('codex');
  const [version, setVersion] = useState('');
  const versionId = useId();

  const reload = useCallback(async () => {
    setList(await listOwnerUpgrades().catch(() => []));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const guarded = async (fn: () => Promise<OwnerUpgrade>, reason: string) => {
    await act.run(async () => {
      try {
        await stepUp.run(fn, reason);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      await reload();
    });
  };
  const kind = ITEMS.find(([i]) => i === item)?.[1] ?? 'runtime';
  const versionOk = /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(version);
  return (
    <Panel title={t.upgradeTitle} sub={t.upgradeSub} testId="owner-upgrades">
      {owner ? (
        <form
          aria-label={t.upgradeTitle}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void guarded(
              () => startOwnerUpgrade({ kind, item, version }),
              t.upgradeStepUp({ item, version }),
            );
          }}
        >
          <DySelect
            label={t.upgradeItem}
            value={item}
            options={ITEMS.map(([i]) => [i, i] as const)}
            onChange={setItem}
          />
          <label htmlFor={versionId} className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
            {t.upgradeVersion}
            <input
              id={versionId}
              value={version}
              onChange={(e) => {
                setVersion(e.target.value.trim());
              }}
              className="min-h-10 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.9375rem] font-normal sm:min-h-9 sm:text-[0.875rem]"
            />
          </label>
          <DyButton type="submit" variant="primary" icon="rocket" disabled={!versionOk} busy={act.busy}>
            {t.upgradeStart}
          </DyButton>
        </form>
      ) : (
        <p className="m-0 text-[0.875rem] text-dy-ink-3">{t.upgradeOwnerOnly}</p>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      {list.length === 0 ? (
        <EmptyLine>{t.upgradeNone}</EmptyLine>
      ) : (
        <Rows label={t.upgradeTitle}>
          {list.map((u) => (
            <Row
              key={u.id}
              testId="owner-upgrade"
              title={
                <span className="flex flex-wrap items-baseline gap-2">
                  <b>{u.item}</b>
                  <span className="font-dy-mono">{u.version}</span>
                </span>
              }
              meta={
                <>
                  {u.fromVersion === null ? null : <span>{t.upgradeFrom({ from: u.fromVersion })}</span>}
                  {u.canaryResult === null ? null : (
                    <span>{t.upgradeCanary[u.canaryResult] ?? u.canaryResult}</span>
                  )}
                </>
              }
              trail={
                <>
                  <Pill tone={u.state === 'done' ? 'green' : u.state === 'canary' ? 'teal' : 'neutral'}>
                    {t.upgradeStates[u.state] ?? u.state}
                  </Pill>
                  {owner && u.state === 'canary' ? (
                    <DyButton
                      variant="primary"
                      busy={act.busy}
                      onClick={() => {
                        void guarded(() => confirmOwnerUpgrade(u.id), t.upgradeConfirmStepUp);
                      }}
                    >
                      {t.upgradeConfirm}
                    </DyButton>
                  ) : null}
                  {owner && (u.state === 'canary' || u.state === 'done') ? (
                    <DyButton
                      variant="ghost"
                      busy={act.busy}
                      onClick={() => {
                        void guarded(() => rollbackOwnerUpgrade(u.id), t.upgradeRollbackStepUp);
                      }}
                    >
                      {t.upgradeRollback}
                    </DyButton>
                  ) : null}
                </>
              }
            />
          ))}
        </Rows>
      )}
    </Panel>
  );
}
