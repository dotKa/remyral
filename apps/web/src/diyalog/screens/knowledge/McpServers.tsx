import { type ReactNode, type SubmitEvent, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  archiveMcpServer,
  assignMcpServer,
  bindMcpSecrets,
  getMcpServer,
  listMcpServers,
  MCP_ALL_PROJECTS,
  MCP_EFFECTS,
  MCP_HEADER_NAME,
  MCP_SERVER_ID,
  MCP_SLOT,
  MCP_TOOL_GLOB,
  MCP_VERSION,
  type McpEffect,
  mcpFormatOk,
  type McpHeaderInput,
  mcpHostOk,
  mcpIdReserved,
  mcpLiteralOk,
  type McpRule,
  type McpServerDetail,
  type McpServerSummary,
  mcpUrlOk,
  type McpVersion,
  type McpWorker,
  probeMcpServer,
  publishMcpServer,
  saveMcpToolPolicy,
  unassignMcpServer,
} from '../../../api/mcp';
import { type CredentialView, listCredentials } from '../../../api/vault';
import { listWorkers } from '../../../api/workers';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { RuntimeMark } from '../../RuntimeMark';
import { ConfirmButton, DyApiError, DyCheck, DyField, DyNotice } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import {
  McpInstalls,
  McpPackageFields,
  type PackageForm,
  PackageMeta,
  packageFormOf,
  packageInput,
  packageProblem,
} from './McpLocal';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2, §5.5): Yetenekler → "MCP sunucuları". Lists the catalog of
 * remote MCP servers; admins publish a server / a new version (panel-signed, always-fresh step-up — a fresh TOTP every
 * time, by design), bind each secret slot to a vault value (always-fresh; the value itself is only ever typed
 * into the sealed vault form), edit the tool permissions (allow / ask / deny; tools not listed are denied, read-only
 * looking tools are suggested for "allow" — by design), run a tool discovery on an `mcp-v1` machine (the master
 * never connects to an MCP server), assign the server to projects and archive it. Server text — titles, descriptions,
 * tool names and descriptions — is untrusted and renders as text.
 */

const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
const SSE_RUNTIMES: ReadonlySet<string> = new Set(['claude-code', 'opencode']);

function urlHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Runs `fn` behind the step-up dialog; a cancelled dialog is not an error. */
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

// ------------------------------------------------------------------------------------------------------ publish form

interface HeaderRow {
  readonly key: number;
  readonly name: string;
  readonly kind: 'literal' | 'secret';
  readonly value: string;
  readonly slot: string;
  readonly format: string;
  readonly why: string;
}

interface FormBase {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly from: McpVersion | null;
}

let headerKey = 0;
function newHeader(over: Partial<HeaderRow> = {}): HeaderRow {
  headerKey += 1;
  return { key: headerKey, name: '', kind: 'literal', value: '', slot: '', format: '{}', why: '', ...over };
}

function headersOf(v: McpVersion | null): HeaderRow[] {
  if (v === null) return [];
  return v.headers.map((h) =>
    h.secret === null
      ? newHeader({ name: h.name, value: h.value ?? '' })
      : newHeader({
          name: h.name,
          kind: 'secret',
          slot: h.secret,
          format: h.format ?? '{}',
          why: v.secretSlots.find((s) => s.slot === h.secret)?.why ?? '',
        }),
  );
}

function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m === null ? '1.0.0' : `${m[1] ?? '1'}.${m[2] ?? '0'}.${String(Number(m[3] ?? '0') + 1)}`;
}

function McpServerForm(props: {
  readonly base: FormBase | null;
  readonly onDone: (message: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().mcp.form;
  const tt = useT().mcp.transport;
  const ts = useT().mcp.stdio;
  const stepUp = useStepUp();
  const from = props.base?.from ?? null;
  const [id, setId] = useState(props.base?.id ?? '');
  const [title, setTitle] = useState(props.base?.title ?? '');
  const [description, setDescription] = useState(props.base?.description ?? '');
  const [version, setVersion] = useState(from === null ? '1.0.0' : bumpPatch(from.version));
  const [transport, setTransport] = useState<'http' | 'sse'>(from?.transport === 'sse' ? 'sse' : 'http');
  // p14-mcp-stdio: a remote server (URL) or a local package (npm / PyPI).
  const [kind, setKind] = useState<'remote' | 'local'>(from?.transport === 'stdio' ? 'local' : 'remote');
  const [pkg, setPkg] = useState<PackageForm>(() => packageFormOf(from));
  const local = kind === 'local';
  const [url, setUrl] = useState(from?.url ?? '');
  const [headers, setHeaders] = useState<HeaderRow[]>(() => headersOf(from));
  const [egress, setEgress] = useState(() => {
    const own = urlHost(from?.url ?? null);
    return (from?.egressHosts ?? []).filter((h) => h !== own).join(', ');
  });
  const [runtimes, setRuntimes] = useState<string[]>(from === null ? [...RUNTIMES] : [...from.runtimes]);
  const [startup, setStartup] = useState(String(from?.limits.startupTimeoutSec ?? 30));
  const [toolTimeout, setToolTimeout] = useState(String(from?.limits.toolTimeoutSec ?? 120));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const allowed = !local && transport === 'sse' ? RUNTIMES.filter((r) => SSE_RUNTIMES.has(r)) : [...RUNTIMES];
  const chosen = runtimes.filter((r) => allowed.includes(r as (typeof RUNTIMES)[number]));
  const idBad = id !== '' && (!MCP_SERVER_ID.test(id) || mcpIdReserved(id));
  const hosts = egress
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');

  function validate(): string | null {
    if (!MCP_SERVER_ID.test(id)) return t.invalid.id;
    if (mcpIdReserved(id)) return t.idReserved;
    if (!MCP_VERSION.test(version.trim())) return t.invalid.version;
    if (local) {
      const p = packageProblem(pkg, ts, t);
      if (p !== null) return p;
    } else if (!mcpUrlOk(url.trim())) return t.invalid.url;
    for (const h of local ? [] : headers) {
      if (!MCP_HEADER_NAME.test(h.name.trim())) return t.invalid.header;
      if (h.kind === 'literal' && !mcpLiteralOk(h.value)) return t.invalid.literal;
      if (h.kind === 'secret' && !MCP_SLOT.test(h.slot.trim())) return t.invalid.slot;
      if (h.kind === 'secret' && !mcpFormatOk(h.format)) return t.invalid.format;
    }
    const bad = hosts.find((h) => !mcpHostOk(h));
    if (bad !== undefined) return t.invalid.host({ host: bad });
    if (chosen.length === 0) return t.invalid.runtimes;
    const s = Number(startup);
    const o = Number(toolTimeout);
    if (!Number.isInteger(s) || s < 1 || s > 120 || !Number.isInteger(o) || o < 1 || o > 600)
      return t.invalid.timeout;
    return null;
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const p = validate();
    setProblem(p);
    if (p !== null) return;
    const hdrs: Record<string, McpHeaderInput> = {};
    const local_ = local ? packageInput(pkg) : null;
    const secrets: { slot: string; why: string }[] = local_ === null ? [] : [...local_.secrets];
    for (const h of local ? [] : headers) {
      if (h.kind === 'literal') hdrs[h.name.trim()] = h.value;
      else {
        const slot = h.slot.trim();
        hdrs[h.name.trim()] = h.format === '{}' ? { secret: slot } : { secret: slot, format: h.format };
        if (!secrets.some((s) => s.slot === slot)) secrets.push({ slot, why: h.why.trim() });
      }
    }
    setBusy(true);
    let message = '';
    const ok = await guarded(
      stepUp,
      async () => {
        const r = await publishMcpServer({
          id,
          title: title.trim() === '' ? id : title.trim(),
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          version: version.trim(),
          ...(local_ === null
            ? {
                transport,
                url: url.trim(),
                ...(Object.keys(hdrs).length === 0 ? {} : { headers: hdrs }),
              }
            : { transport: 'stdio' as const, package: local_.pkg }),
          ...(secrets.length === 0 ? {} : { secrets }),
          ...(hosts.length === 0 ? {} : { egressHosts: hosts }),
          runtimes: chosen,
          limits: { startupTimeoutSec: Number(startup), toolTimeoutSec: Number(toolTimeout) },
        });
        message = t.published({ id: r.server.id, version: r.version.version });
      },
      t.stepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onDone(message);
  }

  const setHeader = (key: number, over: Partial<HeaderRow>): void => {
    setHeaders((hs) => hs.map((h) => (h.key === key ? { ...h, ...over } : h)));
  };

  const heading =
    props.base !== null ? t.titleVersion({ id: props.base.id }) : local ? ts.titleLocal : t.title;
  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label={heading}
      className="flex flex-col gap-3 border-t border-dy-line px-4 py-3.5"
      data-testid="mcp-server-form"
      noValidate
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{heading}</h3>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.sub}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {props.base === null ? (
          <DyField
            label={t.idLabel}
            value={id}
            onChange={setId}
            mono
            hint={t.idHint}
            error={idBad ? (mcpIdReserved(id) ? t.idReserved : t.idHint) : undefined}
          />
        ) : null}
        <DyField label={t.titleLabel} value={title} onChange={setTitle} />
        <DyField label={t.descriptionLabel} value={description} onChange={setDescription} />
        <DyField label={t.versionLabel} value={version} onChange={setVersion} mono hint={t.versionHint} />
        {props.base === null ? (
          <DySelect
            label={ts.kindLabel}
            value={kind}
            onChange={(v) => {
              setKind(v === 'local' ? 'local' : 'remote');
            }}
            options={[
              ['remote', ts.kindRemote],
              ['local', ts.kindLocal],
            ]}
          />
        ) : null}
        {local ? null : (
          <>
            <DySelect
              label={t.transportLabel}
              value={transport}
              onChange={(v) => {
                setTransport(v === 'sse' ? 'sse' : 'http');
              }}
              options={[
                ['http', tt.http],
                ['sse', tt.sse],
              ]}
            />
            <DyField label={t.urlLabel} value={url} onChange={setUrl} mono hint={t.urlHint} />
          </>
        )}
      </div>
      {local ? <McpPackageFields value={pkg} onChange={setPkg} /> : null}
      {!local && transport === 'sse' ? (
        <DyNotice tone="amber" testId="mcp-sse-note">
          {t.sseRuntimes}
        </DyNotice>
      ) : null}
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" hidden={local}>
        <legend className="mb-1 text-[0.8125rem] font-bold">{t.headersTitle}</legend>
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.headersHint}</p>
        {headers.map((h) => (
          <div
            key={h.key}
            className="grid gap-2 rounded-[10px] border border-dy-line p-2.5 sm:grid-cols-2"
            data-testid="mcp-header-row"
          >
            <DyField
              label={t.headerName}
              value={h.name}
              mono
              onChange={(v) => {
                setHeader(h.key, { name: v });
              }}
            />
            <DySelect
              label={t.headerKind}
              value={h.kind}
              onChange={(v) => {
                setHeader(h.key, { kind: v === 'secret' ? 'secret' : 'literal' });
              }}
              options={[
                ['literal', t.headerLiteral],
                ['secret', t.headerSecret],
              ]}
            />
            {h.kind === 'literal' ? (
              <DyField
                label={t.headerValue}
                value={h.value}
                mono
                onChange={(v) => {
                  setHeader(h.key, { value: v });
                }}
              />
            ) : (
              <>
                <DyField
                  label={t.headerSlot}
                  value={h.slot}
                  mono
                  onChange={(v) => {
                    setHeader(h.key, { slot: v });
                  }}
                />
                <DyField
                  label={t.headerFormat}
                  value={h.format}
                  mono
                  hint={t.headerFormatHint}
                  onChange={(v) => {
                    setHeader(h.key, { format: v });
                  }}
                />
                <DyField
                  label={t.slotWhy}
                  value={h.why}
                  onChange={(v) => {
                    setHeader(h.key, { why: v });
                  }}
                />
              </>
            )}
            <div className="flex items-end">
              <DyButton
                variant="ghost"
                icon="xc"
                onClick={() => {
                  setHeaders((hs) => hs.filter((x) => x.key !== h.key));
                }}
              >
                {t.removeHeader}
              </DyButton>
            </div>
          </div>
        ))}
        <div>
          <DyButton
            variant="secondary"
            icon="plus"
            onClick={() => {
              setHeaders((hs) => [...hs, newHeader()]);
            }}
          >
            {t.addHeader}
          </DyButton>
        </div>
      </fieldset>
      <DyField
        label={local ? ts.egressLabel : t.egressLabel}
        value={egress}
        onChange={setEgress}
        mono
        hint={local ? ts.egressHint : t.egressHint}
      />
      <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-2 border-0 p-0">
        <legend className="mb-1 text-[0.8125rem] font-bold">{t.runtimesLegend}</legend>
        {RUNTIMES.map((r) => (
          <DyCheck
            key={r}
            label={<RuntimeMark runtime={r} />}
            checked={chosen.includes(r)}
            disabled={!allowed.includes(r)}
            testId={`mcp-runtime-${r}`}
            onChange={(on) => {
              setRuntimes((rs) => (on ? [...rs.filter((x) => x !== r), r] : rs.filter((x) => x !== r)));
            }}
          />
        ))}
      </fieldset>
      {local && chosen.includes('pi') ? (
        <DyNotice tone="amber" testId="mcp-pi-note">
          {ts.piNote}
        </DyNotice>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <DyField label={t.startupLabel} value={startup} onChange={setStartup} inputMode="numeric" />
        <DyField label={t.toolLabel} value={toolTimeout} onChange={setToolTimeout} inputMode="numeric" />
      </div>
      {problem === null ? null : (
        <DyNotice tone="red" testId="mcp-form-problem">
          {problem}
        </DyNotice>
      )}
      <DyApiError error={error} />
      <div className="flex flex-wrap gap-2">
        <DyButton type="submit" variant="primary" icon="key" busy={busy}>
          {t.publish}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------------------------------------------- detail

function SignerPill(props: { readonly v: McpVersion }): ReactNode {
  const t = useT().mcp.detail;
  return (
    <span data-testid="mcp-signer">
      <Pill tone={props.v.signer === 'panel' ? 'amber' : 'neutral'} icon="key">
        {props.v.signer === 'panel' ? t.signerPanel : t.signerOffline}
      </Pill>
    </span>
  );
}

function Versions(props: { readonly versions: readonly McpVersion[] }): ReactNode {
  const t = useT().mcp;
  const fmt = useFormat();
  return (
    <section className="flex flex-col gap-2" aria-label={t.detail.versionsTitle}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.detail.versionsTitle}</h4>
      <Rows label={t.detail.versionsTitle} testId="mcp-versions">
        {props.versions.map((v) => (
          <Row
            key={v.version}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-dy-mono">{v.version}</span>
                <Pill tone="teal">{t.transport[v.transport]}</Pill>
                <SignerPill v={v} />
              </span>
            }
            meta={
              <>
                {v.url === null ? null : (
                  <span className="font-dy-mono [overflow-wrap:anywhere]">{v.url}</span>
                )}
                <PackageMeta v={v} />
                <span className="font-dy-mono">{t.detail.specHash({ hash: v.specSha256.slice(0, 12) })}</span>
                <span>{t.detail.hosts({ list: fmt.list(v.egressHosts) })}</span>
                <span>
                  {t.detail.limits({ startup: v.limits.startupTimeoutSec, tool: v.limits.toolTimeoutSec })}
                </span>
                <span className="flex flex-wrap gap-2">
                  {v.runtimes.map((r) => (
                    <RuntimeMark key={r} runtime={r} />
                  ))}
                </span>
                <span>{fmt.dateTime(v.createdAt)}</span>
              </>
            }
          />
        ))}
      </Rows>
    </section>
  );
}

function Secrets(props: {
  readonly detail: McpServerDetail;
  readonly admin: boolean;
  readonly onSaved: (message: string) => void;
}): ReactNode {
  const t = useT().mcp.secrets;
  const stepUp = useStepUp();
  const latest = props.detail.versions[0] ?? null;
  const slots = latest?.secretSlots ?? [];
  const binding = (slot: string) =>
    props.detail.secrets.find((b) => b.project === MCP_ALL_PROJECTS && b.slot === slot);
  const bound = (slot: string): string => binding(slot)?.credentialId ?? '';
  // Viewers get the credential's name, not its vault id.
  const boundLabel = (slot: string): string => {
    const b = binding(slot);
    return b === undefined ? '' : (b.credentialName ?? b.credentialId);
  };
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(slots.map((s) => [s.slot, bound(s.slot)])),
  );
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!props.admin || slots.length === 0) return;
    listCredentials().then(
      (c) => {
        setCreds(c.filter((x) => x.state === 'active'));
      },
      () => {
        setCreds([]);
      },
    );
  }, [props.admin, slots.length]);

  async function save(): Promise<void> {
    setBusy(true);
    const ok = await guarded(
      stepUp,
      async () => {
        await bindMcpSecrets(
          props.detail.server.id,
          MCP_ALL_PROJECTS,
          slots
            .map((s) => ({ slot: s.slot, credentialId: choice[s.slot] ?? '' }))
            .filter((b) => b.credentialId !== ''),
        );
      },
      t.stepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onSaved(t.saved);
  }

  return (
    <section className="flex flex-col gap-2" data-testid="mcp-secrets" aria-label={t.title}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.title}</h4>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.sub}</p>
      {slots.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.none}</p>
      ) : (
        <>
          {slots.map((s) =>
            props.admin ? (
              <div key={s.slot} className="flex flex-col gap-0.5">
                <DySelect
                  label={t.slotLabel({ slot: s.slot })}
                  value={choice[s.slot] ?? ''}
                  onChange={(v) => {
                    setChoice((c) => ({ ...c, [s.slot]: v }));
                  }}
                  options={[
                    ['', t.choose],
                    ...(creds ?? []).map((c) => [c.id, `${c.name} (${c.id})`] as const),
                  ]}
                />
                <span className="text-[0.78125rem] text-dy-muted [overflow-wrap:anywhere]">{s.why}</span>
              </div>
            ) : (
              <p key={s.slot} className="m-0 text-[0.8125rem]">
                <span className="font-dy-mono">{s.slot}</span> →{' '}
                {boundLabel(s.slot) === '' ? t.unbound : boundLabel(s.slot)}
              </p>
            ),
          )}
          {props.admin && creds !== null && creds.length === 0 ? (
            <DyNotice tone="amber">{t.vaultEmpty}</DyNotice>
          ) : null}
          {props.admin ? (
            <div>
              <DyButton
                variant="primary"
                icon="key"
                busy={busy}
                onClick={() => {
                  void save();
                }}
              >
                {t.save}
              </DyButton>
            </div>
          ) : null}
        </>
      )}
      <DyApiError error={error} />
    </section>
  );
}

interface ExtraRule {
  readonly key: number;
  readonly tool: string;
  readonly effect: McpEffect;
}

let ruleKey = 0;

function Policy(props: {
  readonly detail: McpServerDetail;
  readonly admin: boolean;
  readonly onSaved: (message: string) => void;
}): ReactNode {
  const t = useT().mcp.policy;
  const stepUp = useStepUp();
  const latest = props.detail.versions[0]?.version ?? null;
  const tools = props.detail.tools.filter((x) => latest === null || x.version === latest);
  const names = new Set(tools.map((x) => x.name));
  const global = props.detail.policies.find((p) => p.project === MCP_ALL_PROJECTS)?.rules ?? [];
  const [effects, setEffects] = useState<Record<string, McpEffect>>(() =>
    Object.fromEntries(tools.map((x) => [x.name, global.find((r) => r.tool === x.name)?.effect ?? x.effect])),
  );
  const [extra, setExtra] = useState<ExtraRule[]>(() =>
    global
      .filter((r) => !names.has(r.tool))
      .map((r) => {
        ruleKey += 1;
        return { key: ruleKey, tool: r.tool, effect: r.effect };
      }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const suggested = tools.filter((x) => x.suggestedAllow && effects[x.name] !== 'allow');

  async function save(): Promise<void> {
    if (extra.some((r) => !MCP_TOOL_GLOB.test(r.tool.trim()))) {
      setProblem(t.invalidGlob);
      return;
    }
    setProblem(null);
    const rules: McpRule[] = [
      ...tools.map((x) => ({ tool: x.name, effect: effects[x.name] ?? 'deny' })),
      ...extra.map((r) => ({ tool: r.tool.trim(), effect: r.effect })),
    ];
    setBusy(true);
    const ok = await guarded(
      stepUp,
      async () => {
        await saveMcpToolPolicy(props.detail.server.id, MCP_ALL_PROJECTS, rules);
      },
      t.stepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onSaved(t.saved);
  }

  const effectOptions = MCP_EFFECTS.map((e) => [e, t.effects[e]] as const);
  return (
    <section className="flex flex-col gap-2" data-testid="mcp-policy" aria-label={t.title}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.title}</h4>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.sub}</p>
      <p className="m-0 text-[0.78125rem] font-medium" data-testid="mcp-unlisted-denied">
        {t.unlisted}
      </p>
      {tools.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noTools}</p>
      ) : (
        <Rows label={t.title} testId="mcp-tools">
          {tools.map((x) => (
            <Row
              key={x.name}
              testId="mcp-tool"
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono [overflow-wrap:anywhere]">{x.name}</span>
                  {x.suggestedAllow ? (
                    <span data-testid="mcp-tool-suggest">
                      <Pill tone="green">{t.suggest}</Pill>
                    </span>
                  ) : null}
                </span>
              }
              meta={
                <span
                  className="w-full text-dy-muted [overflow-wrap:anywhere]"
                  data-testid="mcp-tool-description"
                >
                  {x.description}
                </span>
              }
              actions={
                props.admin ? (
                  <DySelect
                    label={t.toolLabel({ tool: x.name })}
                    value={effects[x.name] ?? 'deny'}
                    onChange={(v) => {
                      setEffects((es) => ({ ...es, [x.name]: v === 'allow' || v === 'ask' ? v : 'deny' }));
                    }}
                    options={effectOptions}
                  />
                ) : (
                  <Pill tone={x.effect === 'allow' ? 'green' : x.effect === 'ask' ? 'amber' : 'red'}>
                    {t.effects[effects[x.name] ?? x.effect]}
                  </Pill>
                )
              }
            />
          ))}
        </Rows>
      )}
      {props.admin ? (
        <>
          {suggested.length > 0 ? (
            <div>
              <DyButton
                variant="secondary"
                icon="checkc"
                onClick={() => {
                  setEffects((es) => ({
                    ...es,
                    ...Object.fromEntries(suggested.map((x) => [x.name, 'allow' as const])),
                  }));
                }}
              >
                {t.applySuggested}
              </DyButton>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <h5 className="m-0 text-[0.8125rem] font-bold">{t.extraTitle}</h5>
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.extraHint}</p>
            {extra.map((r) => (
              <div
                key={r.key}
                className="grid gap-2 sm:grid-cols-[1fr_auto_auto]"
                data-testid="mcp-extra-rule"
              >
                <DyField
                  label={t.extraTool}
                  value={r.tool}
                  mono
                  onChange={(v) => {
                    setExtra((rs) => rs.map((x) => (x.key === r.key ? { ...x, tool: v } : x)));
                  }}
                />
                <DySelect
                  label={t.toolLabel({ tool: r.tool })}
                  value={r.effect}
                  onChange={(v) => {
                    const e: McpEffect = v === 'allow' || v === 'ask' ? v : 'deny';
                    setExtra((rs) => rs.map((x) => (x.key === r.key ? { ...x, effect: e } : x)));
                  }}
                  options={effectOptions}
                />
                <div className="flex items-end">
                  <DyButton
                    variant="ghost"
                    icon="xc"
                    onClick={() => {
                      setExtra((rs) => rs.filter((x) => x.key !== r.key));
                    }}
                  >
                    {t.extraRemove}
                  </DyButton>
                </div>
              </div>
            ))}
            <div>
              <DyButton
                variant="secondary"
                icon="plus"
                onClick={() => {
                  ruleKey += 1;
                  setExtra((rs) => [...rs, { key: ruleKey, tool: '', effect: 'ask' }]);
                }}
              >
                {t.extraAdd}
              </DyButton>
            </div>
          </div>
          {problem === null ? null : <DyNotice tone="red">{problem}</DyNotice>}
          <div>
            <DyButton
              variant="primary"
              icon="checkc"
              busy={busy}
              onClick={() => {
                void save();
              }}
            >
              {t.save}
            </DyButton>
          </div>
        </>
      ) : null}
      <DyApiError error={error} />
    </section>
  );
}

function Probe(props: {
  readonly detail: McpServerDetail;
  readonly workers: readonly McpWorker[];
  readonly onStarted: (message: string) => void;
  readonly onRefresh: () => void;
}): ReactNode {
  const t = useT().mcp.probe;
  const fmt = useFormat();
  const stepUp = useStepUp();
  const ts = useT().mcp.stdio;
  const [version, setVersion] = useState(props.detail.versions[0]?.version ?? '');
  // p14-mcp-stdio: a local server is probed only where that version is installed (the master never runs it).
  const stdio = props.detail.versions.find((v) => v.version === version)?.transport === 'stdio';
  const connected = stdio
    ? props.detail.installs
        .filter((i) => i.version === version && i.state === 'installed' && i.connected)
        .map((i) => ({ id: i.workerId, name: i.name, connected: true }))
    : props.workers.filter((w) => w.connected);
  const [picked, setWorker] = useState('');
  const worker = connected.some((w) => w.id === picked) ? picked : (connected[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(): Promise<void> {
    if (worker === '' || version === '') return;
    setBusy(true);
    const ok = await guarded(
      stepUp,
      async () => {
        await probeMcpServer(props.detail.server.id, version, worker);
      },
      t.stepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onStarted(t.started);
  }

  return (
    <section className="flex flex-col gap-2" data-testid="mcp-probe" aria-label={t.title}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.title}</h4>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.sub}</p>
      {connected.length === 0 ? (
        <>
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="mcp-probe-none">
            {stdio ? ts.probeNotInstalled : t.noWorkers}
          </p>
          {props.detail.versions.length > 1 ? (
            <DySelect
              label={t.versionLabel}
              value={version}
              onChange={setVersion}
              options={props.detail.versions.map((v) => [v.version, v.version] as const)}
            />
          ) : null}
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <DySelect
            label={t.worker}
            value={worker}
            onChange={setWorker}
            options={connected.map((w) => [w.id, w.name] as const)}
          />
          <DySelect
            label={t.versionLabel}
            value={version}
            onChange={setVersion}
            options={props.detail.versions.map((v) => [v.version, v.version] as const)}
          />
          <div className="flex items-end">
            <DyButton
              variant="primary"
              icon="search"
              busy={busy}
              onClick={() => {
                void run();
              }}
            >
              {t.run}
            </DyButton>
          </div>
        </div>
      )}
      <DyApiError error={error} />
      {props.detail.probes.length === 0 ? null : (
        <>
          <div className="flex items-center gap-2">
            <h5 className="m-0 text-[0.8125rem] font-bold">{t.historyTitle}</h5>
            <DyButton variant="ghost" icon="retry" onClick={props.onRefresh}>
              {t.refresh}
            </DyButton>
          </div>
          <Rows label={t.historyTitle} testId="mcp-probes">
            {props.detail.probes.map((p) => (
              <Row
                key={p.opId}
                tone={p.state === 'failed' ? 'red' : undefined}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-dy-mono">{p.workerId}</span>
                    <span className="font-dy-mono">{p.version}</span>
                    <Pill tone={p.state === 'succeeded' ? 'green' : p.state === 'failed' ? 'red' : 'neutral'}>
                      {t.states[p.state]}
                    </Pill>
                  </span>
                }
                meta={
                  <>
                    {p.toolCount === null ? null : <span>{t.toolCount({ n: p.toolCount })}</span>}
                    {p.error === null ? null : <span className="[overflow-wrap:anywhere]">{p.error}</span>}
                    <span>{fmt.dateTime(p.at)}</span>
                  </>
                }
              />
            ))}
          </Rows>
        </>
      )}
    </section>
  );
}

function Assignments(props: {
  readonly detail: McpServerDetail;
  readonly admin: boolean;
  readonly projects: readonly Project[];
  readonly onSaved: (message: string) => void;
}): ReactNode {
  const t = useT().mcp.assign;
  const stepUp = useStepUp();
  const [project, setProject] = useState<string>(MCP_ALL_PROJECTS);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const label = (p: string): string => (p === MCP_ALL_PROJECTS ? t.all : p);
  const serverRuntimes = props.detail.versions[0]?.runtimes ?? [];

  async function add(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const ok = await guarded(
      stepUp,
      async () => {
        await assignMcpServer({
          serverId: props.detail.server.id,
          project,
          runtimes: runtimes.length === 0 ? null : runtimes,
          version: version === '' ? null : version,
        });
      },
      t.stepUp,
      setError,
    );
    setBusy(false);
    if (ok) props.onSaved(t.saved);
  }

  async function remove(id: string): Promise<void> {
    const ok = await guarded(
      stepUp,
      async () => {
        await unassignMcpServer(id);
      },
      t.stepUp,
      setError,
    );
    if (ok) props.onSaved(t.removed);
  }

  return (
    <section className="flex flex-col gap-2" data-testid="mcp-assignments" aria-label={t.title}>
      <h4 className="m-0 text-[0.8125rem] font-bold">{t.title}</h4>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.switchNote}</p>
      {props.detail.assignments.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.none}</p>
      ) : (
        <Rows label={t.title}>
          {props.detail.assignments.map((a) => (
            <Row
              key={a.id}
              testId="mcp-assignment"
              title={label(a.project)}
              meta={
                <>
                  <span>
                    {a.runtimes === null
                      ? t.runtimesAll
                      : a.runtimes.map((r) => <RuntimeMark key={r} runtime={r} className="mr-2" />)}
                  </span>
                  <span>{a.version === null ? t.latest : t.pinned({ version: a.version })}</span>
                </>
              }
              actions={
                props.admin ? (
                  <ConfirmButton
                    label={t.remove}
                    question={t.removeQuestion({ project: label(a.project) })}
                    confirmLabel={t.removeConfirm}
                    testId={`mcp-unassign-${a.id}`}
                    onConfirm={() => void remove(a.id)}
                  />
                ) : undefined
              }
            />
          ))}
        </Rows>
      )}
      {props.admin && !props.detail.server.archived ? (
        <form
          onSubmit={(e) => void add(e)}
          className="flex flex-col gap-3"
          aria-label={t.add}
          data-testid="mcp-assign-form"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <DySelect
              label={t.project}
              value={project}
              onChange={setProject}
              options={[
                [MCP_ALL_PROJECTS, t.all],
                ...props.projects.map((p) => [p.id, p.name === p.id ? p.id : `${p.name} (${p.id})`] as const),
              ]}
            />
            <DySelect
              label={t.versionLabel}
              value={version}
              onChange={setVersion}
              options={[['', t.latest], ...props.detail.versions.map((v) => [v.version, v.version] as const)]}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {serverRuntimes.map((r) => (
              <DyCheck
                key={r}
                label={<RuntimeMark runtime={r} />}
                checked={runtimes.includes(r)}
                onChange={(on) => {
                  setRuntimes((rs) => (on ? [...rs, r] : rs.filter((x) => x !== r)));
                }}
              />
            ))}
          </div>
          <div>
            <DyButton type="submit" variant="primary" icon="plus" busy={busy}>
              {t.add}
            </DyButton>
          </div>
        </form>
      ) : null}
      <DyApiError error={error} />
    </section>
  );
}

function McpServerDetailView(props: {
  readonly id: string;
  readonly admin: boolean;
  readonly projects: readonly Project[];
  readonly workers: readonly McpWorker[];
  readonly onNewVersion: (base: FormBase) => void;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const t = useT().mcp;
  const stepUp = useStepUp();
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const [generation, setGeneration] = useState(0);
  const { id } = props;
  const load = useCallback(
    (quiet = false) => {
      getMcpServer(id).then(
        (d) => {
          setDetail(d);
          // A poll keeps the editable sections (secrets, policy) as they are.
          if (!quiet) setGeneration((g) => g + 1);
        },
        (err: unknown) => {
          setError(toApiError(err));
        },
      );
    },
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);
  // p14-mcp-stdio: follow a running install (per-machine progress) every few seconds.
  const installing = detail?.installActions.some((a) => a.state === 'running') === true;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => {
      load(true);
    }, 4000);
    return () => {
      clearInterval(timer);
    };
  }, [installing, load]);
  const saved = (message: string): void => {
    setNotice(message);
    load();
  };

  async function archive(): Promise<void> {
    const ok = await guarded(
      stepUp,
      async () => {
        await archiveMcpServer(id);
      },
      t.detail.archiveStepUp,
      setError,
    );
    if (ok) props.onChanged(t.detail.archivedNotice({ id }));
  }

  if (detail === null)
    return (
      <div className="border-t border-dy-line px-4 py-3">
        <DyApiError error={error} />
        {error === null ? <SkeletonRows label={t.detail.loading} rows={2} /> : null}
      </div>
    );
  const latest = detail.versions[0] ?? null;
  return (
    <div className="flex flex-col gap-4 border-t border-dy-line px-4 py-3.5" data-testid="mcp-server-detail">
      {detail.server.description === '' ? null : (
        <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere]">{detail.server.description}</p>
      )}
      <DyNotice tone="neutral">{t.detail.untrusted}</DyNotice>
      <Versions versions={detail.versions} />
      {detail.versions.some((v) => v.transport === 'stdio') ? (
        <McpInstalls detail={detail} admin={props.admin} onChanged={saved} />
      ) : null}
      {/* `key`: the sections re-read their initial state from a fresh detail after each save. */}
      <Secrets key={`s${String(generation)}`} detail={detail} admin={props.admin} onSaved={saved} />
      <Policy key={`p${String(generation)}`} detail={detail} admin={props.admin} onSaved={saved} />
      {props.admin && !detail.server.archived ? (
        <Probe
          detail={detail}
          workers={props.workers}
          onStarted={saved}
          onRefresh={() => {
            load();
          }}
        />
      ) : null}
      <Assignments detail={detail} admin={props.admin} projects={props.projects} onSaved={saved} />
      <DyApiError error={error} />
      {props.admin && !detail.server.archived ? (
        <div className="flex flex-wrap gap-2">
          <DyButton
            variant="secondary"
            icon="plus"
            onClick={() => {
              props.onNewVersion({
                id: detail.server.id,
                title: detail.server.title,
                description: detail.server.description,
                from: latest,
              });
            }}
          >
            {t.detail.newVersion}
          </DyButton>
          <ConfirmButton
            label={t.detail.archive}
            question={t.detail.archiveQuestion({ id })}
            confirmLabel={t.detail.archiveConfirm}
            testId="mcp-archive"
            onConfirm={() => void archive()}
          />
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ list

function ServerRow(props: {
  readonly s: McpServerSummary;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const t = useT().mcp;
  const s = props.s;
  const host = urlHost(s.url);
  return (
    <Row
      testId="mcp-server"
      title={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-dy-mono">{s.id}</span>
          <span className="[overflow-wrap:anywhere]">{s.title}</span>
          {s.transport === null ? null : <Pill tone="teal">{t.transport[s.transport]}</Pill>}
          {s.archived ? <Pill tone="neutral">{t.panel.archived}</Pill> : null}
        </span>
      }
      meta={
        <>
          <span className="font-dy-mono">{s.latest ?? t.panel.noVersion}</span>
          {host === null ? null : <span className="font-dy-mono">{host}</span>}
          <span className="flex flex-wrap gap-2">
            {s.runtimes.map((r) => (
              <RuntimeMark key={r} runtime={r} />
            ))}
          </span>
          <span data-testid="mcp-server-counts">
            {s.toolsKnown === 0 ? t.panel.toolsUnknown : t.panel.counts(s.toolCounts)}
          </span>
          <span>{t.panel.assignments({ n: s.assignments })}</span>
        </>
      }
      actions={
        <DyButton variant="secondary" aria-expanded={props.open} onClick={props.onToggle}>
          {props.open ? t.panel.close : t.panel.open}
        </DyButton>
      }
    />
  );
}

export function McpServersPanel(props: {
  readonly admin: boolean;
  readonly projects: readonly Project[];
}): ReactNode {
  const t = useT().mcp;
  const [data, setData] = useState<{
    servers: readonly McpServerSummary[];
    workersWithMcp: number;
    workers: readonly McpWorker[];
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<FormBase | 'new' | null>(null);

  const load = useCallback(() => {
    listMcpServers().then(
      async (l) => {
        const workers =
          l.mcpWorkers ??
          (await listWorkers().then(
            (ws) => ws.map((w) => ({ id: w.id, name: w.name, connected: w.connected })),
            () => [],
          ));
        setData({ servers: l.servers, workersWithMcp: l.workersWithMcp, workers });
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, []);
  useEffect(load, [load]);
  const done = (message: string): void => {
    setNotice(message);
    setForm(null);
    load();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="mcp-servers">
      <DyApiError error={error} />
      <DyNotice tone="amber" testId="mcp-windows-note">
        {t.panel.windowsNote}
      </DyNotice>
      <Panel
        title={t.panel.title}
        sub={t.panel.sub}
        flush
        testId="mcp-server-list"
        aside={
          props.admin && form === null ? (
            <DyButton
              variant="secondary"
              icon="plus"
              onClick={() => {
                setForm('new');
              }}
            >
              {t.panel.add}
            </DyButton>
          ) : undefined
        }
      >
        {data === null ? (
          error === null ? (
            <SkeletonRows label={t.panel.loading} rows={3} />
          ) : null
        ) : (
          <>
            <p className="m-0 px-4 py-2 text-[0.8125rem] text-dy-muted" data-testid="mcp-workers">
              {t.panel.workers({ n: data.workersWithMcp })}
            </p>
            {data.servers.length === 0 ? (
              <EmptyLine testId="mcp-empty">{props.admin ? t.panel.emptyAdmin : t.panel.empty}</EmptyLine>
            ) : (
              <Rows label={t.panel.listLabel}>
                {data.servers.map((s) => (
                  <div key={s.id}>
                    <ServerRow
                      s={s}
                      open={open === s.id}
                      onToggle={() => {
                        setOpen(open === s.id ? null : s.id);
                      }}
                    />
                    {open === s.id ? (
                      <McpServerDetailView
                        id={s.id}
                        admin={props.admin}
                        projects={props.projects}
                        workers={data.workers}
                        onNewVersion={setForm}
                        onChanged={(m) => {
                          setOpen(null);
                          done(m);
                        }}
                      />
                    ) : null}
                  </div>
                ))}
              </Rows>
            )}
          </>
        )}
        {form === null ? null : (
          <McpServerForm
            key={form === 'new' ? 'new' : form.id}
            base={form === 'new' ? null : form}
            onDone={done}
            onCancel={() => {
              setForm(null);
            }}
          />
        )}
      </Panel>
    </div>
  );
}
