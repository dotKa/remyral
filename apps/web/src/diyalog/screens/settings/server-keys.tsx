import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { getKeys, type KeyItem, keyApply, keyDryRun } from '../../../api/panelSettings';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyNotice } from '../../common/notices';
import { DyApiError } from '../forms';
import { DyButton, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';
import { CommandLine } from './ServerUpdatePanel';

/**
 * p17-panel-settings Part 5 (docs/design/p17-panel-settings.md §7): Ayarlar → Sunucu ayarları → Anahtarlar. The keys the
 * panel rotates (webhook HMAC with an overlap, the skills panel key with the old one kept trusted) — each step after
 * "Ne değişeceğini göster" (the dry run) and an always-fresh authenticator code — and, for the lease-signing and the
 * master key, the exact host procedure (they are not rotated online; the design note says why).
 */
export function KeyRotationPanel(props: { readonly owner: boolean }): ReactNode {
  const all = useT();
  const t = all.panelSettings.keys;
  const loader = useSubmit();
  const [items, setItems] = useState<readonly KeyItem[] | null>(null);
  const load = useCallback((): void => {
    void loader.run(async () => {
      setItems(await getKeys());
    });
  }, [loader]);
  useEffect(load, []);
  if (items === null)
    return (
      <div className="grid gap-3">
        <ErrorLine error={loader.error} what={t.title} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.title} rows={3} /> : null}
      </div>
    );
  return (
    <div className="grid gap-4" data-testid="dy-panel-keys">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      {items.map((i) => (
        <KeyCard key={i.item} item={i} owner={props.owner} onChanged={load} />
      ))}
    </div>
  );
}

function KeyCard(props: {
  readonly item: KeyItem;
  readonly owner: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const all = useT();
  const t = all.panelSettings.keys;
  const i = props.item;
  const text = t.items[i.item];
  const stepUp = useStepUp();
  const act = useSubmit();
  const [preview, setPreview] = useState<{ action: string; effect: readonly string[] } | null>(null);
  const [shown, setShown] = useState<{ secret: string | null; publicKey: string | null } | null>(null);
  const actionLabel = (a: string): string =>
    a === 'activate' ? t.activate : a === 'cancel' || a === 'retire' ? t.cancel : t.rotate;
  return (
    <Panel title={text.title} testId={`dy-key-${i.item}`}>
      <p className="m-0 text-[0.875rem] text-dy-muted">{text.sub}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.8125rem]">
        <Pill tone={i.online ? 'teal' : 'neutral'}>{i.online ? t.online : t.host}</Pill>
        <span>
          {/* p17-ui-polish: no environment variable name here — "Kaynak: panel ()" showed empty brackets. */}
          {all.panelSettings.sourceOnly({ source: all.panelSettings.mail.source[i.source] ?? i.source })}
        </span>
        {i.keyId === null ? null : <code className="font-dy-mono">{i.keyId}</code>}
        {i.pending ? <Pill tone="amber">{t.pending}</Pill> : null}
      </div>
      {i.publicKey === null ? null : (
        <p className="m-0 mt-2 text-[0.8125rem]">
          {t.publicKey}: <code className="font-dy-mono break-all">{i.publicKey}</code>
        </p>
      )}
      {i.retired.length === 0 ? null : (
        // p17-ui-polish: the earlier keys had no label (a bare key under the public key).
        <ul className="m-0 mt-1 list-none p-0 text-[0.75rem] text-dy-muted" aria-label={t.retiredKeys}>
          <li aria-hidden="true" className="font-medium">
            {t.retiredKeys}:
          </li>
          {i.retired.map((k) => (
            <li key={k}>
              <code className="font-dy-mono break-all">{k}</code>
            </li>
          ))}
        </ul>
      )}
      {!i.online ? (
        <div className="mt-3 grid gap-1">
          <p className="m-0 font-bold">{t.procedure}</p>
          <pre className="m-0 overflow-x-auto rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.75rem] whitespace-pre-wrap">
            {i.procedure.join('\n')}
          </pre>
        </div>
      ) : props.owner ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {i.actions.map((a) => (
            <DyButton
              key={a}
              busy={act.busy}
              onClick={() => {
                setShown(null);
                void act.run(async () => {
                  setPreview({ action: a, effect: await keyDryRun(i.item, a) });
                });
              }}
            >
              {`${actionLabel(a)} — ${t.dryRun}`}
            </DyButton>
          ))}
        </div>
      ) : null}
      {preview === null ? null : (
        <DyNotice
          tone="amber"
          icon="key"
          title={t.effect}
          testId={`dy-key-preview-${i.item}`}
          className="mt-3"
        >
          <ul className="m-0 grid gap-1 pl-4">
            {preview.effect.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <DyButton
              variant="primary"
              busy={act.busy}
              onClick={() => {
                const a = preview.action;
                void act.run(async () => {
                  try {
                    const out = await stepUp.run(() => keyApply(i.item, a), text.title);
                    setPreview(null);
                    setShown(out.secret === null && out.publicKey === null ? null : out);
                    props.onChanged();
                  } catch (err) {
                    if (err instanceof StepUpCancelledError) return;
                    throw err;
                  }
                });
              }}
            >
              {actionLabel(preview.action)}
            </DyButton>
            <DyButton
              onClick={() => {
                setPreview(null);
              }}
            >
              {all.panelSettings.confirm.no}
            </DyButton>
          </div>
        </DyNotice>
      )}
      {shown === null ? null : (
        <DyNotice tone="amber" icon="key" testId={`dy-key-shown-${i.item}`} className="mt-3">
          {shown.secret === null ? null : (
            <>
              <p className="m-0 font-bold">{t.secretOnce}</p>
              <p className="m-0 text-[0.8125rem]">{all.panelSettings.secret.shownOnce}</p>
              <CommandLine text={shown.secret} />
            </>
          )}
          {shown.publicKey === null ? null : (
            <p className="m-0">
              {t.publicKey}: <code className="font-dy-mono break-all">{shown.publicKey}</code>
            </p>
          )}
        </DyNotice>
      )}
      <DyApiError error={act.error} className="mt-2" />
    </Panel>
  );
}
