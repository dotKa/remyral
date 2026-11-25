import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  bedrockIamPolicy,
  type BedrockStatus,
  getBedrock,
  MODEL_LABELS,
  removeBedrock,
  saveBedrock,
  SOURCE_TEXT,
  testBedrock,
} from '../../../api/bedrock';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { ConfirmButton, DyApiError, DyCopyButton, DyDetails, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, Panel, Pill, SkeletonRows } from '../parts';
import { useGuardedOp } from './integrations-ops';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Entegrasyonlar → AWS Bedrock (embeddings) in the Diyalog language, feature for
 * feature with the classic `BedrockIntegrationCard` (p10-bedrock-integration-panel): the active embedding provider
 * and why panel keys are not in use, region / model, write-only access keys ("leave both empty to keep"), save and
 * remove with an always-fresh code, "Bağlantıyı test et" (vector size and latency or the AWS error), and the IAM policy
 * (copyable) with the model-access steps. The keys are never returned by the master and never shown.
 */

type Json = Record<string, unknown>;

type BedrockText = Messages['integrations']['bedrock'];

function sourceText(t: BedrockText, source: string): string | undefined {
  if (source === 'panel') return t.sources.panel;
  if (source === 'environment') return t.sources.environment;
  if (source === 'instance role') return t.sources.instanceRole;
  return undefined;
}

function modelText(t: BedrockText, model: string): string | undefined {
  if (model === 'cohere.embed-multilingual-v3') return t.models.cohereMultilingualV3;
  if (model === 'cohere.embed-v4:0') return t.models.cohereV4;
  if (model === 'amazon.titan-embed-text-v2:0') return t.models.titanV2;
  return undefined;
}

function TestResult(props: { readonly test: Json }): ReactNode {
  const tx = useT().integrations.bedrock;
  const t = props.test;
  if (t.ok === true)
    return (
      <DyNotice tone="green" live>
        <span data-testid="bedrock-test">
          {tx.testOk} <span className="font-dy-mono">{typeof t.model === 'string' ? t.model : 'model'}</span>{' '}
          (<span className="font-dy-mono">{typeof t.region === 'string' ? t.region : tx.regionFallback}</span>
          ){' '}
          {tx.testOkResult({
            ms: typeof t.latencyMs === 'number' ? String(t.latencyMs) : '?',
            dims: typeof t.dims === 'number' ? String(t.dims) : '?',
          })}
        </span>
      </DyNotice>
    );
  return (
    <DyNotice tone="red" live>
      <span data-testid="bedrock-test">
        {tx.testFailed}{' '}
        <span className="font-dy-mono">{typeof t.error === 'string' ? t.error : tx.errorFallback}</span>
        {typeof t.httpStatus === 'number' ? ` (HTTP ${String(t.httpStatus)})` : ''}.
        {typeof t.hint === 'string' ? ` ${t.hint}` : ''}
      </span>
    </DyNotice>
  );
}

function ActiveLine(props: { readonly status: BedrockStatus }): ReactNode {
  const t = useT().integrations.bedrock;
  const a = props.status.active;
  return (
    <div className="flex flex-col gap-2 text-[0.875rem]" data-testid="bedrock-active">
      <p className="m-0">
        <span className="text-dy-muted">{t.activeProvider} </span>
        {a.provider === null ? (
          t.noProvider
        ) : (
          <>
            <span className="font-dy-mono">{a.model}</span>
            {a.region === null ? null : (
              <>
                {' '}
                · <span className="font-dy-mono">{a.region}</span>
              </>
            )}
            {a.source === null ? '' : t.source({ source: sourceText(t, a.source) ?? SOURCE_TEXT[a.source] })}
          </>
        )}
      </p>
      {a.panelInactiveReason !== null ? <DyNotice tone="amber">{a.panelInactiveReason}</DyNotice> : null}
    </div>
  );
}

function BedrockForm(props: {
  readonly status: BedrockStatus;
  readonly onChanged: (s: BedrockStatus) => void;
  readonly notice: string | null;
  readonly setNotice: (n: string | null) => void;
}): ReactNode {
  const t = useT().integrations.bedrock;
  const { status, notice, setNotice } = props;
  const current = status.integration;
  const [region, setRegion] = useState(current?.settings.region ?? status.env.region ?? 'us-east-1');
  const [model, setModel] = useState(current?.settings.model ?? status.options.defaultModel);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [test, setTest] = useState<Json | null>(current?.lastTest ?? null);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const regions = status.options.regions.includes(region)
    ? status.options.regions
    : [region, ...status.options.regions];
  const policy = bedrockIamPolicy(region, model);

  const save = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const keys =
        accessKeyId.trim() === '' && secretAccessKey.trim() === ''
          ? {}
          : { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
      const out = await guarded(() => saveBedrock({ region, model, ...keys }), t.stepUpSave);
      if (out === null) return;
      setAccessKeyId('');
      setSecretAccessKey('');
      setNotice(t.saved);
      props.onChanged(await getBedrock());
    });
  };
  const runTest = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      setTest(await testBedrock());
    });
  };
  const remove = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const out = await guarded(async () => {
        await removeBedrock();
        return true;
      }, t.stepUpRemove);
      if (out === null) return;
      props.onChanged(await getBedrock());
    });
  };

  return (
    <Panel
      title={t.title}
      testId="dy-bedrock"
      aside={
        current === null ? (
          <Pill tone="neutral" icon="clock">
            {t.notConnected}
          </Pill>
        ) : current.usable ? (
          status.active.panelInUse ? (
            <Pill tone="green" icon="checkc">
              {t.connected}
            </Pill>
          ) : (
            <Pill tone="amber" icon="flag">
              {t.savedUnused}
            </Pill>
          )
        ) : (
          <Pill tone="red" icon="xc">
            {t.keysUnusable}
          </Pill>
        )
      }
      sub={t.panelSub}
    >
      <div className="flex flex-col gap-4">
        <ActiveLine status={status} />
        <form
          aria-label={t.formLabel}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <DySelect
              label={t.region}
              value={region}
              options={regions.map((r) => [r, r] as const)}
              onChange={setRegion}
            />
            <DySelect
              label={t.model}
              value={model}
              options={status.options.models.map(
                (m) => [m, modelText(t, m) ?? MODEL_LABELS[m] ?? m] as const,
              )}
              onChange={setModel}
            />
          </div>
          <DyField
            label={t.accessKeyId}
            autoComplete="off"
            spellCheck={false}
            mono
            value={accessKeyId}
            placeholder={current === null ? 'AKIA…' : t.keyPlaceholder({ hint: current.keyIdHint })}
            onChange={setAccessKeyId}
          />
          <DyField
            label={t.secretAccessKey}
            type="password"
            autoComplete="off"
            value={secretAccessKey}
            hint={current === null ? t.secretHint : t.keepHint}
            onChange={setSecretAccessKey}
          />
          {current !== null ? (
            <p className="m-0 text-[0.78125rem] text-dy-muted">
              {t.savedKey.before} <span className="font-dy-mono">…{current.keyIdHint}</span>{' '}
              {t.savedKey.middle} <span className="font-dy-mono">{current.keyFingerprint}</span>
            </p>
          ) : null}
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.reindexNote}</p>
          <FormActions>
            <DyButton type="submit" variant="primary" busy={act.busy}>
              {t.save}
            </DyButton>
            {current !== null ? (
              <>
                <DyButton icon="retry" disabled={act.busy} onClick={() => void runTest()}>
                  {t.test}
                </DyButton>
                <ConfirmButton
                  label={t.remove}
                  question={t.removeQuestion}
                  disabled={act.busy}
                  onConfirm={() => void remove()}
                />
              </>
            ) : null}
          </FormActions>
        </form>
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {notice !== null ? (
          <DyNotice tone="green" live>
            {notice}
          </DyNotice>
        ) : null}
        {test !== null ? <TestResult test={test} /> : null}
        <DyDetails summary={t.iamSummary}>
          <div className="flex flex-col gap-2 text-[0.875rem]">
            <p className="m-0 text-dy-muted">
              {t.iam.before} <span className="font-dy-mono">bedrock:InvokeModel</span> {t.iam.after}
              {/* i18n-ignore: version, product or permission name */}
            </p>
            <pre
              className="m-0 overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-3 font-dy-mono text-[0.75rem]"
              data-testid="bedrock-iam-policy"
            >
              {policy}
            </pre>
            <div>
              <DyCopyButton text={policy} label={t.copyPolicy} />
            </div>
            <p className="m-0 text-dy-muted">
              {t.access.before} <span className="font-dy-mono">{region}</span> {t.access.after}
            </p>
          </div>
        </DyDetails>
      </div>
    </Panel>
  );
}

export function BedrockPanel(): ReactNode {
  const t = useT().integrations.bedrock;
  const [status, setStatus] = useState<BedrockStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useSubmit();
  const reload = useCallback(async () => {
    setStatus(await getBedrock());
  }, []);
  useEffect(() => {
    void load.run(reload);
  }, []);
  if (status === null)
    return load.error === null ? (
      <Panel title={t.title} flush>
        <SkeletonRows label={t.loading} rows={2} />
      </Panel>
    ) : (
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
    );
  return (
    <BedrockForm
      key={status.integration?.updatedAt ?? 'none'}
      status={status}
      onChanged={setStatus}
      notice={notice}
      setNotice={setNotice}
    />
  );
}
