import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  getStorage,
  saveStorage,
  type StorageConfig,
  type StorageLimits,
  type StorageMode,
  type StorageProvider,
  type StorageSse,
  type StorageStatus,
  storagePolicy,
  testStorage,
} from '../../../api/storage';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import {
  CopyLine,
  DyApiError,
  DyCheck,
  DyCopyButton,
  DyDetails,
  DyField,
  DyNotice,
  FormActions,
} from '../forms';
import { DyButton, DySelect, Panel, Pill, SkeletonRows } from '../parts';
import { useGuardedOp } from './integrations-ops';

/**
 * p17-object-storage — Ayarlar → Entegrasyonlar → Depolama: where job outputs and other blobs go (the master's disk or
 * an S3-compatible bucket: Amazon S3, Cloudflare R2, MinIO), the bucket settings, the write-only access keys (never
 * returned, never shown), server-side encryption, the owner's limits, "Bağlantıyı test et" (a put / head / get / delete
 * round trip), usage per location, files still in the database (the `blobs:migrate` command) and the least-privilege
 * bucket policy. Saving asks for a fresh code; switching to a bucket is refused unless the round trip passes.
 */

type Json = Record<string, unknown>;
const MIB = 1024 * 1024;

const mib = (n: number): string => String(Math.round(n / MIB));

function TestResult(props: { readonly test: Json }): ReactNode {
  const t = useT().integrations.storage;
  const r = props.test;
  if (r.ok === true)
    return (
      <DyNotice tone="green" live>
        <span data-testid="storage-test">
          {t.testOk({ ms: typeof r.latencyMs === 'number' ? String(r.latencyMs) : '?' })}
        </span>
      </DyNotice>
    );
  return (
    <DyNotice tone="red" live>
      <span data-testid="storage-test">
        {t.testFailed}{' '}
        <span className="font-dy-mono">{typeof r.error === 'string' ? r.error : t.errorFallback}</span>
        {typeof r.httpStatus === 'number' ? ` (HTTP ${String(r.httpStatus)})` : ''}
        {typeof r.step === 'string' ? ` ${t.stepFailed({ step: r.step })}` : ''}.
        {typeof r.hint === 'string' ? ` ${r.hint}` : ''}
      </span>
    </DyNotice>
  );
}

const emptyConfig = (s: StorageStatus): StorageConfig =>
  s.config ?? {
    provider: 'r2',
    endpoint: '',
    region: s.options.defaults.r2?.region ?? 'auto',
    bucket: '',
    pathStyle: s.options.defaults.r2?.pathStyle ?? true,
    prefix: '',
    sse: 'none',
    kmsKeyId: '',
  };

function StorageForm(props: {
  readonly status: StorageStatus;
  readonly onChanged: (s: StorageStatus) => void;
  readonly notice: string | null;
  readonly setNotice: (n: string | null) => void;
}): ReactNode {
  const t = useT().integrations.storage;
  const fmt = useFormat();
  const { status } = props;
  const [mode, setMode] = useState<StorageMode>(status.mode);
  const [cfg, setCfg] = useState<StorageConfig>(emptyConfig(status));
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [limits, setLimits] = useState({
    maxFile: mib(status.limits.maxFileBytes),
    maxJob: mib(status.limits.maxJobBytes),
    threshold: mib(status.limits.thresholdBytes),
    ttl: String(status.limits.downloadTtlSeconds),
    days: String(status.limits.shareMaxDays),
  });
  const [test, setTest] = useState<Json | null>(status.lastTest);
  const { notice, setNotice } = props;
  const act = useSubmit();
  const guarded = useGuardedOp();
  const set = <K extends keyof StorageConfig>(k: K, v: StorageConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
  };
  const pickProvider = (p: StorageProvider): void => {
    const d = status.options.defaults[p];
    setCfg((c) => ({
      ...c,
      provider: p,
      region: d?.region ?? c.region,
      pathStyle: d?.pathStyle ?? c.pathStyle,
      endpoint: p === 'aws' ? '' : c.endpoint,
    }));
  };
  const policy = storagePolicy(cfg.bucket === '' ? '<bucket>' : cfg.bucket, cfg.prefix);
  const toLimits = (): StorageLimits => ({
    maxFileBytes: Math.min(Number(limits.maxFile) * MIB, 2 * 1024 * MIB - 1),
    maxJobBytes: Number(limits.maxJob) * MIB,
    thresholdBytes: Math.round(Number(limits.threshold) * MIB),
    downloadTtlSeconds: Number(limits.ttl),
    shareMaxDays: Number(limits.days),
  });

  const save = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const keys =
        accessKeyId.trim() === '' && secretAccessKey.trim() === ''
          ? {}
          : { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
      try {
        const out = await guarded(
          () =>
            saveStorage({
              mode,
              ...(mode === 's3' || status.config !== null ? { config: cfg } : {}),
              ...keys,
              limits: toLimits(),
            }),
          t.stepUpSave,
        );
        if (out === null) return;
        setAccessKeyId('');
        setSecretAccessKey('');
        setNotice(t.saved);
        setTest(out.lastTest);
        props.onChanged(out);
      } catch (err) {
        // A failed round trip: show what the bucket answered (no secret is in it).
        if (err instanceof ApiError && err.code === 'storage_test_failed') {
          const result = err.details.result;
          if (typeof result === 'object' && result !== null) setTest(result as Json);
        }
        throw err;
      }
    });
  };
  const runTest = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      setTest(await testStorage());
    });
  };

  const sseValue = cfg.sse === 'aws:kms' ? 'kms' : cfg.sse;
  const local = status.local;
  return (
    <Panel
      title={t.title}
      testId="dy-storage"
      aside={
        status.usable ? (
          <Pill tone="green" icon="checkc">
            {t.active}: {status.mode === 's3' ? t.modes.s3 : t.modes.local}
          </Pill>
        ) : (
          <Pill tone="red" icon="xc">
            {t.unusable}
          </Pill>
        )
      }
      sub={t.panelSub}
    >
      <div className="flex flex-col gap-4">
        {status.problem !== null ? <DyNotice tone="red">{status.problem}</DyNotice> : null}
        <form
          aria-label={t.formLabel}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DySelect
            label={t.mode}
            value={mode}
            options={[
              ['local', t.modes.local],
              ['s3', t.modes.s3],
            ]}
            onChange={(v) => {
              setMode(v === 's3' ? 's3' : 'local');
            }}
          />
          {mode === 's3' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <DySelect
                  label={t.provider}
                  value={cfg.provider}
                  options={status.options.providers.map((p) => [p, t.providers[p]] as const)}
                  onChange={(v) => {
                    pickProvider(v as StorageProvider);
                  }}
                />
                <DyField
                  label={t.bucket}
                  value={cfg.bucket}
                  mono
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(v) => {
                    set('bucket', v.trim());
                  }}
                />
              </div>
              <DyField
                label={t.endpoint}
                value={cfg.endpoint}
                mono
                spellCheck={false}
                autoComplete="off"
                placeholder={cfg.provider === 'aws' ? '' : 'https://…'}
                hint={t.endpointHint}
                onChange={(v) => {
                  set('endpoint', v.trim());
                }}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <DyField
                  label={t.region}
                  value={cfg.region}
                  mono
                  hint={t.regionHint}
                  onChange={(v) => {
                    set('region', v.trim());
                  }}
                />
                <DyField
                  label={t.prefix}
                  value={cfg.prefix}
                  mono
                  hint={t.prefixHint}
                  onChange={(v) => {
                    set('prefix', v.trim());
                  }}
                />
              </div>
              <DyCheck
                label={t.pathStyle}
                checked={cfg.pathStyle}
                onChange={(v) => {
                  set('pathStyle', v);
                }}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <DySelect
                  label={t.sse}
                  value={sseValue}
                  options={[
                    ['none', t.sseModes.none],
                    ['AES256', t.sseModes.AES256],
                    ['kms', t.sseModes.kms],
                  ]}
                  onChange={(v) => {
                    set('sse', (v === 'kms' ? 'aws:kms' : v) as StorageSse);
                  }}
                />
                {cfg.sse === 'aws:kms' ? (
                  <DyField
                    label={t.kmsKeyId}
                    value={cfg.kmsKeyId}
                    mono
                    onChange={(v) => {
                      set('kmsKeyId', v.trim());
                    }}
                  />
                ) : null}
              </div>
              <DyField
                label={t.accessKeyId}
                autoComplete="off"
                spellCheck={false}
                mono
                value={accessKeyId}
                placeholder={status.keyIdHint === null ? '' : t.keyPlaceholder({ hint: status.keyIdHint })}
                onChange={setAccessKeyId}
              />
              <DyField
                label={t.secretAccessKey}
                type="password"
                autoComplete="off"
                value={secretAccessKey}
                hint={status.keyIdHint === null ? t.secretHint : t.keepHint}
                onChange={setSecretAccessKey}
              />
              {status.keyIdHint !== null && status.keyFingerprint !== null ? (
                <p className="m-0 text-[0.78125rem] text-dy-muted">
                  {t.savedKey.before} <span className="font-dy-mono">…{status.keyIdHint}</span>{' '}
                  {t.savedKey.middle} <span className="font-dy-mono">{status.keyFingerprint}</span>
                </p>
              ) : null}
              <p className="m-0 text-[0.78125rem] text-dy-muted">{t.roundTripNote}</p>
            </>
          ) : null}
          <DyDetails summary={t.limitsTitle}>
            <div className="grid gap-3 sm:grid-cols-2">
              <DyField
                label={t.maxFile}
                inputMode="numeric"
                value={limits.maxFile}
                hint={t.limitRange({ min: '1', max: '2048' })}
                onChange={(v) => {
                  setLimits((l) => ({ ...l, maxFile: v.replace(/[^0-9]/g, '') }));
                }}
              />
              <DyField
                label={t.maxJob}
                inputMode="numeric"
                value={limits.maxJob}
                hint={t.limitRange({ min: '1', max: '65536' })}
                onChange={(v) => {
                  setLimits((l) => ({ ...l, maxJob: v.replace(/[^0-9]/g, '') }));
                }}
              />
              <DyField
                label={t.threshold}
                inputMode="decimal"
                value={limits.threshold}
                hint={t.thresholdHint}
                onChange={(v) => {
                  setLimits((l) => ({ ...l, threshold: v.replace(/[^0-9.]/g, '') }));
                }}
              />
              <DyField
                label={t.downloadTtl}
                inputMode="numeric"
                value={limits.ttl}
                hint={t.limitRange({ min: '60', max: '3600' })}
                onChange={(v) => {
                  setLimits((l) => ({ ...l, ttl: v.replace(/[^0-9]/g, '') }));
                }}
              />
              <DyField
                label={t.shareMaxDays}
                inputMode="numeric"
                value={limits.days}
                hint={t.limitRange({ min: '1', max: '30' })}
                onChange={(v) => {
                  setLimits((l) => ({ ...l, days: v.replace(/[^0-9]/g, '') }));
                }}
              />
            </div>
          </DyDetails>
          <FormActions>
            <DyButton type="submit" variant="primary" busy={act.busy}>
              {t.save}
            </DyButton>
            <DyButton icon="retry" disabled={act.busy} onClick={() => void runTest()}>
              {t.test}
            </DyButton>
          </FormActions>
        </form>
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {notice !== null ? (
          <DyNotice tone="green" live>
            {notice}
          </DyNotice>
        ) : null}
        {test !== null ? <TestResult test={test} /> : null}
        <div className="flex flex-col gap-1 text-[0.875rem]" data-testid="storage-usage">
          <p className="m-0 font-bold">{t.usageTitle}</p>
          {status.usage.map((u) => (
            <p key={u.location} className="m-0 text-dy-muted">
              {t.usageRow({
                where: u.location === 's3' ? t.whereS3 : t.whereLocal,
                n: String(u.blobs),
                size: fmt.bytes(u.bytes),
              })}
            </p>
          ))}
          <p className="m-0 text-dy-muted">
            {t.localDir({
              dir: local.dir,
              free: local.freeBytes === null ? '?' : fmt.bytes(local.freeBytes),
            })}
          </p>
          {status.legacyBytes > 0 ? (
            <div className="flex flex-col gap-1" data-testid="storage-legacy">
              <p className="m-0">{t.legacy({ size: fmt.bytes(status.legacyBytes) })}</p>
              <CopyLine text="remyral-master blobs:migrate" about={t.usageTitle} />
            </div>
          ) : null}
        </div>
        {mode === 's3' ? (
          <DyDetails summary={t.policySummary}>
            <div className="flex flex-col gap-2 text-[0.875rem]">
              <p className="m-0 text-dy-muted">{t.policyIntro}</p>
              <pre
                className="m-0 overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-3 font-dy-mono text-[0.75rem]"
                data-testid="storage-policy"
              >
                {policy}
              </pre>
              <div>
                <DyCopyButton text={policy} label={t.copyPolicy} />
              </div>
              <p className="m-0 text-dy-muted">{t.guide}</p>
            </div>
          </DyDetails>
        ) : null}
      </div>
    </Panel>
  );
}

export function StoragePanel(): ReactNode {
  const t = useT().integrations.storage;
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useSubmit();
  const reload = useCallback(async () => {
    setStatus(await getStorage());
  }, []);
  useEffect(() => {
    void load.run(reload);
  }, []);
  if (status === null)
    return load.error === null ? (
      <Panel title={t.title} flush>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
    );
  return (
    <StorageForm
      key={status.updatedAt}
      status={status}
      onChanged={setStatus}
      notice={notice}
      setNotice={setNotice}
    />
  );
}
