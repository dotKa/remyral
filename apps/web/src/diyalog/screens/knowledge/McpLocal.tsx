import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import { cancelFleetAction } from '../../../api/fleetTools';
import {
  continueMcpInstall,
  installMcpVersion,
  lookupMcpPackage,
  MCP_ARG,
  MCP_BIN,
  MCP_PACKAGE_VERSION,
  MCP_SLOT,
  mcpEnvNameOk,
  mcpFormatOk,
  type McpHeaderInput,
  type McpInstallAction,
  mcpIntegrityOk,
  mcpLiteralOk,
  type McpPackageInput,
  type McpPackageManager,
  mcpPackageNameOk,
  type McpServerDetail,
  type McpVersion,
  removeMcpVersion,
  retryMcpInstall,
} from '../../../api/mcp';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { ConfirmButton, CopyLine, DyApiError, DyCheck, DyField, DyNotice, DyTextarea } from '../forms';
import { DyButton, DySelect, Pill, Row, Rows } from '../parts';

/**
 * p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7): Yetenekler → MCP sunucuları, local (npm / PyPI)
 * packages — the package part of the "add server" form (with a registry lookup the master does), the package card of
 * a version and the per-machine installs (canary first; the canary's lockfile is what every other machine installs;
 * install scripts never run). Installing, continuing after the canary and retrying need a fresh authenticator code
 * every time (by design: these steps run third-party code on machines). Server and worker text renders as text.
 */

/** Package manager names (product names, not translated). */
const MANAGER_NAME: Readonly<Record<McpPackageManager, string>> = { npm: 'npm', pypi: 'PyPI' }; // i18n-ignore

export interface EnvRow {
  readonly key: number;
  readonly name: string;
  readonly kind: 'literal' | 'secret';
  readonly value: string;
  readonly slot: string;
  readonly format: string;
  readonly why: string;
}

export interface PackageForm {
  readonly manager: McpPackageManager;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bin: string;
  /** Bin names the lookup found (npm). */
  readonly bins: readonly string[];
  /** One argument per line. */
  readonly args: string;
  readonly env: readonly EnvRow[];
}

let envKey = 0;
export function newEnvRow(over: Partial<EnvRow> = {}): EnvRow {
  envKey += 1;
  return { key: envKey, name: '', kind: 'literal', value: '', slot: '', format: '{}', why: '', ...over };
}

export function packageFormOf(v: McpVersion | null): PackageForm {
  const p = v?.package ?? null;
  if (p === null) {
    return { manager: 'npm', name: '', version: '', integrity: '', bin: '', bins: [], args: '', env: [] };
  }
  return {
    manager: p.manager,
    name: p.name,
    version: p.version,
    integrity: p.integrity,
    bin: p.bin,
    bins: [],
    args: p.args.join('\n'),
    env: p.env.map((e) =>
      e.secret === null
        ? newEnvRow({ name: e.name, value: e.value ?? '' })
        : newEnvRow({
            name: e.name,
            kind: 'secret',
            slot: e.secret,
            format: e.format ?? '{}',
            why: v?.secretSlots.find((s) => s.slot === e.secret)?.why ?? '',
          }),
    ),
  };
}

function argsOf(f: PackageForm): string[] {
  return f.args
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}

/** The first problem of the package part (null: fine). */
export function packageProblem(
  f: PackageForm,
  t: ReturnType<typeof useT>['mcp']['stdio'],
  ft: ReturnType<typeof useT>['mcp']['form'],
): string | null {
  if (!mcpPackageNameOk(f.manager, f.name.trim())) return t.invalid.name;
  if (!MCP_PACKAGE_VERSION.test(f.version.trim())) return t.invalid.version;
  if (!mcpIntegrityOk(f.manager, f.integrity.trim())) return t.invalid.integrity;
  if (!MCP_BIN.test(f.bin.trim())) return t.invalid.bin;
  if (argsOf(f).some((a) => !MCP_ARG.test(a))) return t.invalid.arg;
  for (const e of f.env) {
    if (!mcpEnvNameOk(e.name.trim())) return t.invalid.env;
    if (e.kind === 'literal' && !mcpLiteralOk(e.value)) return ft.invalid.literal;
    if (e.kind === 'secret' && !MCP_SLOT.test(e.slot.trim())) return ft.invalid.slot;
    if (e.kind === 'secret' && !mcpFormatOk(e.format)) return ft.invalid.format;
  }
  return null;
}

/** The publish body's package and the secret slots its env uses. */
export function packageInput(f: PackageForm): {
  readonly pkg: McpPackageInput;
  readonly secrets: { slot: string; why: string }[];
} {
  const env: Record<string, McpHeaderInput> = {};
  const secrets: { slot: string; why: string }[] = [];
  for (const e of f.env) {
    if (e.kind === 'literal') env[e.name.trim()] = e.value;
    else {
      const slot = e.slot.trim();
      env[e.name.trim()] = e.format === '{}' ? { secret: slot } : { secret: slot, format: e.format };
      if (!secrets.some((s) => s.slot === slot)) secrets.push({ slot, why: e.why.trim() });
    }
  }
  const args = argsOf(f);
  return {
    pkg: {
      manager: f.manager,
      name: f.name.trim(),
      version: f.version.trim(),
      integrity: f.integrity.trim(),
      bin: f.bin.trim(),
      ...(args.length === 0 ? {} : { args }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
    },
    secrets,
  };
}

/** The package fields of the "add server" form: manager, name, exact version, lookup, integrity, bin, args, env. */
export function McpPackageFields(props: {
  readonly value: PackageForm;
  readonly onChange: (f: PackageForm) => void;
}): ReactNode {
  const all = useT().mcp;
  const t = all.stdio;
  const ft = all.form;
  const f = props.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [found, setFound] = useState<{ file: string | null; license: string | null } | null>(null);
  const set = (over: Partial<PackageForm>): void => {
    props.onChange({ ...f, ...over });
  };
  const setEnv = (key: number, over: Partial<EnvRow>): void => {
    set({ env: f.env.map((e) => (e.key === key ? { ...e, ...over } : e)) });
  };

  async function lookup(): Promise<void> {
    setError(null);
    setFound(null);
    setBusy(true);
    try {
      const r = await lookupMcpPackage({
        manager: f.manager,
        name: f.name.trim(),
        version: f.version.trim(),
      });
      props.onChange({
        ...f,
        integrity: r.integrity,
        bins: r.bins,
        bin: f.bin !== '' ? f.bin : (r.bins[0] ?? ''),
      });
      setFound({ file: r.file, license: r.license });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" data-testid="mcp-package-fields">
      <legend className="mb-1 text-[0.8125rem] font-bold">{t.packageTitle}</legend>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.subLocal}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <DySelect
          label={t.managerLabel}
          value={f.manager}
          onChange={(v) => {
            set({ manager: v === 'pypi' ? 'pypi' : 'npm', integrity: '', bins: [] });
          }}
          options={[
            ['npm', MANAGER_NAME.npm],
            ['pypi', MANAGER_NAME.pypi],
          ]}
        />
        <DyField
          label={t.nameLabel}
          value={f.name}
          mono
          hint={t.nameHint}
          onChange={(v) => {
            set({ name: v });
          }}
        />
        <DyField
          label={t.versionLabel}
          value={f.version}
          mono
          hint={t.versionHint}
          onChange={(v) => {
            set({ version: v });
          }}
        />
        <div className="flex items-end">
          <DyButton
            variant="secondary"
            icon="search"
            busy={busy}
            onClick={() => {
              void lookup();
            }}
          >
            {t.lookup}
          </DyButton>
        </div>
      </div>
      <DyApiError error={error} />
      {found === null ? null : (
        <DyNotice tone="green" testId="mcp-lookup-done">
          {found.file === null ? t.lookupDoneNoFile : t.lookupDone({ file: found.file })}
          {found.license === null ? null : ` · ${t.lookupLicense({ license: found.license })}`}
        </DyNotice>
      )}
      <DyField
        label={t.integrityLabel}
        value={f.integrity}
        mono
        hint={t.integrityHint}
        onChange={(v) => {
          set({ integrity: v });
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <DyField
          label={t.binLabel}
          value={f.bin}
          mono
          hint={t.binHint}
          onChange={(v) => {
            set({ bin: v });
          }}
        />
        {f.bins.length > 1 ? (
          <DySelect
            label={t.binChoose}
            value={f.bin}
            onChange={(v) => {
              set({ bin: v });
            }}
            options={f.bins.map((b) => [b, b] as const)}
          />
        ) : null}
      </div>
      <DyTextarea
        label={t.argsLabel}
        value={f.args}
        mono
        rows={3}
        hint={t.argsHint}
        onChange={(v) => {
          set({ args: v });
        }}
      />
      <div className="flex flex-col gap-2">
        <h5 className="m-0 text-[0.8125rem] font-bold">{t.envTitle}</h5>
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.envHint}</p>
        {f.env.map((e) => (
          <div
            key={e.key}
            className="grid gap-2 rounded-[10px] border border-dy-line p-2.5 sm:grid-cols-2"
            data-testid="mcp-env-row"
          >
            <DyField
              label={t.envName}
              value={e.name}
              mono
              onChange={(v) => {
                setEnv(e.key, { name: v });
              }}
            />
            <DySelect
              label={ft.headerKind}
              value={e.kind}
              onChange={(v) => {
                setEnv(e.key, { kind: v === 'secret' ? 'secret' : 'literal' });
              }}
              options={[
                ['literal', ft.headerLiteral],
                ['secret', ft.headerSecret],
              ]}
            />
            {e.kind === 'literal' ? (
              <DyField
                label={ft.headerValue}
                value={e.value}
                mono
                onChange={(v) => {
                  setEnv(e.key, { value: v });
                }}
              />
            ) : (
              <>
                <DyField
                  label={ft.headerSlot}
                  value={e.slot}
                  mono
                  onChange={(v) => {
                    setEnv(e.key, { slot: v });
                  }}
                />
                <DyField
                  label={ft.headerFormat}
                  value={e.format}
                  mono
                  hint={ft.headerFormatHint}
                  onChange={(v) => {
                    setEnv(e.key, { format: v });
                  }}
                />
                <DyField
                  label={ft.slotWhy}
                  value={e.why}
                  onChange={(v) => {
                    setEnv(e.key, { why: v });
                  }}
                />
              </>
            )}
            <div className="flex items-end">
              <DyButton
                variant="ghost"
                icon="xc"
                onClick={() => {
                  set({ env: f.env.filter((x) => x.key !== e.key) });
                }}
              >
                {t.removeEnv}
              </DyButton>
            </div>
          </div>
        ))}
        <div>
          <DyButton
            variant="secondary"
            icon="plus"
            onClick={() => {
              set({ env: [...f.env, newEnvRow()] });
            }}
          >
            {t.addEnv}
          </DyButton>
        </div>
      </div>
      <DyNotice tone="neutral" testId="mcp-scripts-note">
        {t.scriptsNote}
      </DyNotice>
    </fieldset>
  );
}

/** The package lines of a stdio version (in the versions list). */
export function PackageMeta(props: { readonly v: McpVersion }): ReactNode {
  const t = useT().mcp.stdio;
  const fmt = useFormat();
  const p = props.v.package;
  if (p === null) return null;
  return (
    <span className="flex w-full flex-col gap-1" data-testid="mcp-package">
      <span className="font-dy-mono [overflow-wrap:anywhere]">
        {t.packageLine({ manager: MANAGER_NAME[p.manager], name: p.name, version: p.version })}
      </span>
      <CopyLine text={p.integrity} about={t.integrity({ hash: p.integrity.slice(0, 16) })} />
      <span className="font-dy-mono">{t.bin({ bin: p.bin })}</span>
      {p.args.length === 0 ? null : (
        <span className="font-dy-mono [overflow-wrap:anywhere]">{t.args({ list: p.args.join(' ') })}</span>
      )}
      {p.env.length === 0 ? null : (
        <span className="font-dy-mono">{t.env({ list: fmt.list(p.env.map((e) => e.name)) })}</span>
      )}
    </span>
  );
}

async function guarded(
  stepUp: ReturnType<typeof useStepUp>,
  fn: () => Promise<void>,
  reason: string,
  setError: (e: ApiError | null) => void,
): Promise<boolean> {
  setError(null);
  try {
    await stepUp.run(fn, reason);
    return true;
  } catch (err) {
    if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    return false;
  }
}

const TARGET_TONE: Readonly<Record<string, 'green' | 'red' | 'amber' | 'neutral' | 'teal'>> = {
  succeeded: 'green',
  failed: 'red',
  expired: 'red',
  running: 'teal',
  sent: 'teal',
  held: 'amber',
};

function ActionCard(props: {
  readonly action: McpInstallAction;
  readonly admin: boolean;
  readonly onDone: (message: string) => void;
}): ReactNode {
  const t = useT().mcp.stdio;
  const stepUp = useStepUp();
  const a = props.action;
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const failed = a.targets.filter((x) => x.state === 'failed' || x.state === 'expired');
  const open = a.state === 'running' || a.state === 'held';

  async function act(which: string, fn: () => Promise<unknown>, reason: string, message: string) {
    setBusy(which);
    const ok = await guarded(
      stepUp,
      async () => {
        await fn();
      },
      reason,
      setError,
    );
    setBusy(null);
    if (ok) props.onDone(message);
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[10px] border border-dy-line p-2.5"
      data-testid="mcp-install-action"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] font-bold">
          {t.actionTitle({
            kind: a.kind === 'mcp.remove' ? t.actionKinds.remove : t.actionKinds.install,
            version: a.version ?? '',
          })}
        </span>
        <Pill tone={a.state === 'held' ? 'amber' : a.state === 'done' ? 'green' : 'neutral'}>
          {t.actionStates[a.state]}
        </Pill>
      </div>
      {a.state === 'held' ? (
        <DyNotice tone="amber" testId="mcp-install-held">
          {t.heldNote}
        </DyNotice>
      ) : null}
      <Rows label={t.workersLegend}>
        {a.targets.map((x) => (
          <Row
            key={x.workerId}
            testId="mcp-install-target"
            tone={x.state === 'failed' || x.state === 'expired' ? 'red' : undefined}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span>{x.name}</span>
                <Pill tone={x.phase === 1 ? 'violet' : 'neutral'}>
                  {x.phase === 1 ? t.phaseCanary : t.phaseRest}
                </Pill>
                <Pill tone={TARGET_TONE[x.state] ?? 'neutral'}>{t.targetStates[x.state]}</Pill>
              </span>
            }
            meta={
              x.reason === null && x.detail === null ? undefined : (
                <span className="[overflow-wrap:anywhere]">
                  {[x.reason, x.detail].filter((s) => s !== null).join(' · ')}
                  {x.reason === 'install_scripts_required' ? <ScriptsLink /> : null}
                </span>
              )
            }
          />
        ))}
      </Rows>
      <DyApiError error={error} />
      {props.admin ? (
        <div className="flex flex-wrap gap-2">
          {a.state === 'held' ? (
            <DyButton
              variant="primary"
              icon="key"
              busy={busy === 'continue'}
              onClick={() => {
                void act('continue', () => continueMcpInstall(a.id), t.continueStepUp, t.continued);
              }}
            >
              {t.continue}
            </DyButton>
          ) : null}
          {failed.length > 0 && a.state !== 'cancelled' ? (
            <DyButton
              variant="secondary"
              icon="retry"
              busy={busy === 'retry'}
              onClick={() => {
                void act('retry', () => retryMcpInstall(a.id), t.retryStepUp, t.retried);
              }}
            >
              {t.retry}
            </DyButton>
          ) : null}
          {open ? (
            <DyButton
              variant="ghost"
              icon="xc"
              busy={busy === 'cancel'}
              onClick={() => {
                void act('cancel', () => cancelFleetAction(a.id), t.cancelStepUp, t.cancelled);
              }}
            >
              {t.cancel}
            </DyButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Installs of a stdio server: notes, lockfiles, per-machine state, the latest action and the install form. */
export function McpInstalls(props: {
  readonly detail: McpServerDetail;
  readonly admin: boolean;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const t = useT().mcp.stdio;
  const fmt = useFormat();
  const stepUp = useStepUp();
  const d = props.detail;
  const [version, setVersion] = useState(d.versions[0]?.version ?? '');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pypi = d.versions.some((v) => v.package?.manager === 'pypi');
  const latestAction = d.installActions[0] ?? null;

  async function install(): Promise<void> {
    if (chosen.length === 0 || version === '') {
      setProblem(t.chooseWorkers);
      return;
    }
    setProblem(null);
    setBusy(true);
    const canary = d.stdioWorkers.some((w) => w.canary && chosen.includes(w.id));
    const ok = await guarded(
      stepUp,
      async () => {
        await installMcpVersion(d.server.id, version, {
          workers: chosen,
          rollout: canary ? 'canary-first' : 'all',
        });
      },
      t.installStepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onChanged(t.installStarted);
  }

  async function remove(): Promise<void> {
    if (chosen.length === 0 || version === '') {
      setProblem(t.chooseWorkers);
      return;
    }
    setProblem(null);
    const ok = await guarded(
      stepUp,
      async () => {
        await removeMcpVersion(d.server.id, version, chosen);
      },
      t.removeStepUp,
      setError,
    );
    if (ok) props.onChanged(t.removeStarted);
  }

  return (
    <section className="flex flex-col gap-2" data-testid="mcp-installs" aria-label={t.installsTitle}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.installsTitle}</h4>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.installsSub}</p>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[0.78125rem] text-dy-muted">
        <li>{t.scriptsNote}</li>
        <li>{t.noteWindows}</li>
        <li>{t.noteContainer}</li>
        {pypi ? <li>{t.noteUv}</li> : null}
      </ul>
      <h5 className="m-0 text-[0.8125rem] font-bold">{t.lockTitle}</h5>
      {d.lockfiles.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="mcp-lock-none">
          {t.lockNone}
        </p>
      ) : (
        d.lockfiles.map((l) => (
          <p key={l.version} className="m-0 font-dy-mono text-[0.8125rem]" data-testid="mcp-lockfile">
            {t.lock({
              version: l.version,
              hash: l.sha256.slice(0, 12),
              size: fmt.bytes(l.bytes),
              worker: l.producedOnWorker,
            })}
          </p>
        ))
      )}
      {d.installs.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noInstalls}</p>
      ) : (
        <Rows label={t.installsTitle} testId="mcp-install-rows">
          {d.installs.map((i) => (
            <Row
              key={`${i.workerId}@${i.version}`}
              testId="mcp-install"
              tone={i.state === 'failed' ? 'red' : undefined}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span>{i.name}</span>
                  <span className="font-dy-mono">{i.version}</span>
                  <Pill tone={i.state === 'installed' ? 'green' : i.state === 'failed' ? 'red' : 'neutral'}>
                    {t.installStates[i.state]}
                  </Pill>
                  {i.connected ? null : <Pill tone="neutral">{t.offline}</Pill>}
                </span>
              }
              meta={
                <>
                  {i.digest === null ? null : (
                    <span className="font-dy-mono">{t.digest({ hash: i.digest.slice(7, 19) })}</span>
                  )}
                  {i.error === null ? null : (
                    <span className="[overflow-wrap:anywhere]">
                      {i.error}
                      {i.error.includes(SCRIPTS_ERROR) ? <ScriptsLink /> : null}
                    </span>
                  )}
                  <span>{fmt.dateTime(i.updatedAt)}</span>
                </>
              }
            />
          ))}
        </Rows>
      )}
      {latestAction === null ? null : (
        <ActionCard
          key={latestAction.id}
          action={latestAction}
          admin={props.admin}
          onDone={props.onChanged}
        />
      )}
      {props.admin && !d.server.archived ? (
        d.stdioWorkers.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="mcp-no-stdio-workers">
            {t.noWorkers}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="mcp-install-form">
            <DySelect
              label={t.installVersionLabel}
              value={version}
              onChange={setVersion}
              options={d.versions.map((v) => [v.version, v.version] as const)}
            />
            <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-2 border-0 p-0">
              <legend className="mb-1 text-[0.8125rem] font-bold">{t.workersLegend}</legend>
              {d.stdioWorkers.map((w) => (
                <DyCheck
                  key={w.id}
                  testId={`mcp-install-worker-${w.id}`}
                  label={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>{w.name}</span>
                      {w.canary ? <Pill tone="violet">{t.canary}</Pill> : null}
                      {w.connected ? null : <Pill tone="neutral">{t.offline}</Pill>}
                    </span>
                  }
                  checked={chosen.includes(w.id)}
                  onChange={(on) => {
                    setChosen((cs) =>
                      on ? [...cs.filter((x) => x !== w.id), w.id] : cs.filter((x) => x !== w.id),
                    );
                  }}
                />
              ))}
            </fieldset>
            {problem === null ? null : <DyNotice tone="red">{problem}</DyNotice>}
            <div className="flex flex-wrap gap-2">
              <DyButton
                variant="primary"
                icon="key"
                busy={busy}
                onClick={() => {
                  void install();
                }}
              >
                {t.install}
              </DyButton>
              <ConfirmButton
                label={t.remove}
                question={t.removeQuestion({ version })}
                confirmLabel={t.removeConfirm}
                testId="mcp-remove"
                onConfirm={() => void remove()}
              />
            </div>
          </div>
        )
      ) : null}
      <DyApiError error={error} />
    </section>
  );
}

/** The worker's detail of an install refused for an install script (never shown from here). */
const SCRIPTS_ERROR = 'install script'; // i18n-ignore: matched in the worker's English detail

/**
 * p19-install-scripts: an install refused for an unapproved install script links to the review (Ayarlar → Güvenlik →
 * Kurulum betikleri); the detail names the packages (name@version).
 */
function ScriptsLink(): ReactNode {
  const t = useT().installScripts.failure;
  return (
    <>
      {' · '}
      <Link
        to="/settings/security?tab=scripts"
        className="font-bold text-dy-teal"
        data-testid="mcp-install-scripts-link"
      >
        {t.link}
      </Link>
    </>
  );
}
