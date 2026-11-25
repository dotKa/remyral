import { fill } from '@remyral/i18n';
import { type ReactNode, useState } from 'react';
import {
  type ApiToken,
  type CreateTokenInput,
  curlExample,
  daysLeft,
  type IssuedToken,
  type RotateTokenInput,
  type TokenRules,
  type TokenScope,
} from '../../../api/apiTokens';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DATE_NUMERIC, DyTime } from '../../common/time';
import { DyIcon } from '../../icons';
import type { Tone } from '../../tone';
import {
  ConfirmButton,
  CopyLine,
  DyApiError,
  DyCheck,
  DyDialog,
  DyField,
  DyNotice,
  DyTextarea,
  FormActions,
} from '../forms';
import { DyButton, DySelect, Pill, Row } from '../parts';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §8): the parts both token screens share — the create form, the
 * shown-once secret, a token row with rotate (dialog: overlap + new lifetime) and revoke (two-step confirm). Every
 * create / rotate runs through the step-up provider: the master asks for a code while the policy keeps the
 * `api.tokens` event protected (the safe core, by default).
 */

const LIFETIMES: readonly number[] = [7, 30, 90, 180, 365];
const OVERLAPS: readonly number[] = [0, 15, 60, 240, 1440];

/** The lifetimes offered under `max` (and `max` itself when it is not one of them). */
export function lifetimeChoices(max: number): number[] {
  const out = LIFETIMES.filter((d) => d <= max);
  if (!out.includes(max)) out.push(max);
  return out;
}

/** Parses the IP range field: one address or range per line (or comma separated), empty lines dropped. */
export function cidrLines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ScopePills(props: { readonly scopes: readonly TokenScope[] }): ReactNode {
  const t = useT().apiTokens.scopes;
  return (
    <>
      {props.scopes.map((s) => (
        <Pill key={s} tone={s === 'admin' ? 'violet' : s === 'read' ? 'neutral' : 'teal'}>
          {t[s]}
        </Pill>
      ))}
    </>
  );
}

function stateTone(token: ApiToken, soon: boolean): Tone {
  if (token.state === 'revoked') return 'neutral';
  if (token.state === 'expired') return 'red';
  return soon ? 'amber' : 'green';
}

/** One token: name, hint, scopes, state, use, expiry (a warning from 7 days), rotate / revoke. */
export function TokenRow(props: {
  readonly token: ApiToken;
  readonly showOwner?: boolean;
  readonly busy: boolean;
  readonly onRotate?: ((t: ApiToken) => void) | undefined;
  readonly onRevoke: (t: ApiToken) => void;
}): ReactNode {
  const all = useT();
  const t = all.apiTokens;
  const fmt = useFormat();
  const tok = props.token;
  const left = daysLeft(tok.expiresAt);
  const soon = tok.state === 'active' && left <= 7;
  const live = tok.state === 'active';
  const labels = all.security.events.labels as Readonly<Record<string, string>>;
  return (
    <Row
      testId="api-token-row"
      lead={<DyIcon name="key" className="size-4" />}
      tone={stateTone(tok, soon)}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {tok.name}
          <Pill tone={stateTone(tok, soon)}>
            {soon ? fill(t.list.expiresSoon, { n: Math.max(left, 0) }) : t.states[tok.state]}
          </Pill>
          <ScopePills scopes={tok.scopes} />
        </span>
      }
      meta={
        <>
          <span className="font-dy-mono">{tok.hint}</span>
          {props.showOwner === true ? (
            <span>{fill(t.list.owner, { name: tok.principal.username })}</span>
          ) : null}
          <span>{fill(t.list.expires, { date: fmt.dateWith(tok.expiresAt, DATE_NUMERIC) })}</span>
          {tok.lastUsedAt === null ? (
            <span>{t.list.neverUsed}</span>
          ) : (
            <span>
              {t.list.lastUsed} <DyTime iso={tok.lastUsedAt} />
              {tok.lastUsedIp === null ? null : <span className="font-dy-mono"> · {tok.lastUsedIp}</span>}
            </span>
          )}
          {tok.useCount > 0 ? <span>{fill(t.list.uses, { n: tok.useCount })}</span> : null}
          {tok.previousValidUntil === null ? null : (
            <span>{fill(t.list.overlap, { time: fmt.dateTime(tok.previousValidUntil) })}</span>
          )}
          {tok.allowedCidrs.length === 0 ? null : (
            <span className="font-dy-mono">
              {fill(t.list.ipLimited, { ranges: tok.allowedCidrs.join(', ') })}
            </span>
          )}
          {tok.grantedEvents.length === 0 ? null : (
            <span>
              {fill(t.list.grants, { events: tok.grantedEvents.map((e) => labels[e] ?? e).join(', ') })}
            </span>
          )}
        </>
      }
      actions={
        live ? (
          <>
            {props.onRotate === undefined ? null : (
              <DyButton
                icon="retry"
                disabled={props.busy}
                data-testid={`api-token-rotate-${tok.id}`}
                onClick={() => {
                  props.onRotate?.(tok);
                }}
              >
                {t.rotate.button}
              </DyButton>
            )}
            <ConfirmButton
              label={t.revoke.button}
              question={fill(t.revoke.question, { name: tok.name })}
              confirmLabel={t.revoke.confirm}
              ariaLabel={fill(t.revoke.aria, { name: tok.name })}
              disabled={props.busy}
              testId={`api-token-revoke-${tok.id}`}
              onConfirm={() => {
                props.onRevoke(tok);
              }}
            />
          </>
        ) : undefined
      }
    />
  );
}

/** The new secret, once: a copy button, the warning and a curl line; closing forgets it. */
export function SecretReveal(props: {
  readonly issued: IssuedToken;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().apiTokens.secret;
  return (
    <section
      aria-label={t.title}
      data-testid="api-token-secret"
      className="grid gap-3 rounded-[var(--dy-r-card)] border border-dy-amber bg-dy-card p-4"
    >
      <h2 className="m-0 text-[1rem] font-bold">{t.title}</h2>
      <DyNotice tone="amber" icon="flag">
        {t.warning}
      </DyNotice>
      <CopyLine text={props.issued.secret} about={t.copy} testId="api-token-secret-value" />
      <div className="grid gap-1">
        <span className="text-[0.8125rem] font-bold">{t.usage}</span>
        <CopyLine text={curlExample(window.location.origin, props.issued.secret)} about={t.usage} />
      </div>
      <FormActions>
        <DyButton variant="primary" onClick={props.onClose} data-testid="api-token-secret-done">
          {t.done}
        </DyButton>
      </FormActions>
    </section>
  );
}

/** The create form (name, scopes the role can give, lifetime, IP ranges, event grants when allowed). */
export function CreateTokenForm(props: {
  readonly rules: TokenRules;
  readonly create: (input: CreateTokenInput) => Promise<IssuedToken>;
  readonly onCreated: (issued: IssuedToken) => void;
  readonly testId?: string;
}): ReactNode {
  const all = useT();
  const t = all.apiTokens;
  const labels = all.security.events.labels as Readonly<Record<string, string>>;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<readonly TokenScope[]>(['read']);
  const [days, setDays] = useState(props.rules.defaultDays);
  const [cidrs, setCidrs] = useState('');
  const [grants, setGrants] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = lifetimeChoices(props.rules.maxDays);

  function toggle<T extends string>(list: readonly T[], v: T, on: boolean): T[] {
    return on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v);
  }

  function send(): void {
    setProblem(null);
    if (name.trim() === '') {
      setProblem(t.create.nameRequired);
      return;
    }
    if (scopes.length === 0) {
      setProblem(t.create.scopeRequired);
      return;
    }
    const ranges = cidrLines(cidrs);
    void submit.run(async () => {
      try {
        const issued = await stepUp.run(
          () =>
            props.create({
              name: name.trim(),
              scopes,
              expiresInDays: days,
              ...(ranges.length === 0 ? {} : { allowedCidrs: ranges }),
              ...(grants.length === 0 ? {} : { grantedEvents: grants }),
            }),
          t.create.stepUp,
        );
        setName('');
        setCidrs('');
        setGrants([]);
        props.onCreated(issued);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  return (
    <form
      className="grid gap-4"
      data-testid={props.testId ?? 'api-token-create'}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <DyField
        label={t.create.name}
        value={name}
        maxLength={80}
        placeholder={t.create.namePlaceholder}
        error={problem === t.create.nameRequired ? problem : undefined}
        onChange={setName}
      />
      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.create.scopes}</legend>
        {props.rules.scopes.map((s) => (
          <DyCheck
            key={s}
            testId={`api-token-scope-${s}`}
            label={t.scopes[s]}
            hint={t.scopeHints[s]}
            checked={scopes.includes(s)}
            onChange={(on) => {
              setScopes(toggle(scopes, s, on));
            }}
          />
        ))}
        {problem === t.create.scopeRequired ? (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{problem}</p>
        ) : null}
      </fieldset>
      <div className="grid gap-1">
        <DySelect
          label={t.create.expiry}
          value={String(days)}
          options={choices.map((d) => [String(d), fill(t.create.days, { n: d })] as const)}
          onChange={(v) => {
            setDays(Number(v));
          }}
        />
        <p className="m-0 text-[0.78125rem] text-dy-muted">
          {fill(t.create.expiryHint, { max: props.rules.maxDays })}
        </p>
      </div>
      <DyTextarea
        label={t.create.cidrs}
        hint={t.create.cidrsHint}
        value={cidrs}
        rows={2}
        mono
        onChange={setCidrs}
      />
      {props.rules.grantableEvents.length === 0 ? null : (
        <fieldset className="m-0 grid gap-1 border-0 p-0" data-testid="api-token-grants">
          <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.create.grants}</legend>
          <p className="m-0 mb-1 text-[0.78125rem] text-dy-muted">{t.create.grantsHint}</p>
          {props.rules.grantableEvents.map((e) => (
            <DyCheck
              key={e}
              label={labels[e] ?? e}
              checked={grants.includes(e)}
              onChange={(on) => {
                setGrants(toggle(grants, e, on));
              }}
            />
          ))}
        </fieldset>
      )}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <FormActions>
        <DyButton
          type="submit"
          variant="primary"
          icon="key"
          busy={submit.busy}
          data-testid="api-token-submit"
        >
          {submit.busy ? t.create.submitting : t.create.submit}
        </DyButton>
      </FormActions>
    </form>
  );
}

/** Rotate: how long the old secret keeps working and the new lifetime; then the new secret, once. */
export function RotateDialog(props: {
  readonly token: ApiToken | null;
  readonly rules: TokenRules;
  readonly rotate: (t: ApiToken, input: RotateTokenInput) => Promise<IssuedToken>;
  readonly onClose: () => void;
  readonly onRotated: (issued: IssuedToken) => void;
}): ReactNode {
  const t = useT().apiTokens.rotate;
  const tc = useT().apiTokens.create;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [overlap, setOverlap] = useState(60);
  const [days, setDays] = useState<number | null>(null);
  const tok = props.token;
  const overlapText = (m: number): string =>
    m === 0
      ? t.overlapNone
      : m % 60 === 0
        ? fill(t.overlapHours, { n: m / 60 })
        : fill(t.overlapMinutes, { n: m });

  function go(): void {
    if (tok === null) return;
    void submit.run(async () => {
      try {
        const issued = await stepUp.run(
          () =>
            props.rotate(tok, { overlapMinutes: overlap, ...(days === null ? {} : { expiresInDays: days }) }),
          t.stepUp,
        );
        props.onRotated(issued);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  return (
    <DyDialog
      open={tok !== null}
      onClose={props.onClose}
      title={tok === null ? '' : fill(t.title, { name: tok.name })}
      description={t.sub}
      backdropClose={false}
      testId="api-token-rotate-dialog"
      footer={
        <>
          <DyButton onClick={props.onClose}>{t.cancel}</DyButton>
          <DyButton
            variant="primary"
            icon="retry"
            busy={submit.busy}
            onClick={go}
            data-testid="api-token-rotate-go"
          >
            {t.submit}
          </DyButton>
        </>
      }
    >
      <div className="grid gap-3">
        <DySelect
          label={t.overlap}
          value={String(overlap)}
          options={OVERLAPS.filter((m) => m <= props.rules.maxOverlapMinutes).map(
            (m) => [String(m), overlapText(m)] as const,
          )}
          onChange={(v) => {
            setOverlap(Number(v));
          }}
        />
        <DySelect
          label={t.expiry}
          value={days === null ? '' : String(days)}
          options={[
            ['', t.expirySame] as const,
            ...lifetimeChoices(props.rules.maxDays).map((d) => [String(d), fill(tc.days, { n: d })] as const),
          ]}
          onChange={(v) => {
            setDays(v === '' ? null : Number(v));
          }}
        />
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </DyDialog>
  );
}
