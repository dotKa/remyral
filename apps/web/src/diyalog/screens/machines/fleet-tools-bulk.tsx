import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import {
  type ActionKind,
  type CatalogItem,
  type FleetAction,
  type FleetTools,
  isAdminAction,
  type NewAction,
  startFleetAction,
} from '../../../api/fleetTools';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyCheck, DyDialog, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect } from '../parts';
import { useGuarded } from './tabs/config-shared';
import { stepUpWhy, useFleetWords } from './fleet-tools-parts';
import { SkippedReasons } from './fleet-tools-runtime-updates';
import { fill } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p13-fleet-tools — "Toplu işlem": one item (catalog), one action (Güncelle / Kur / Kaldır → the action kind the
 * item allows), the version (the pin by default; runtimes: one of the versions the workers can install), the targets
 * (selected machines or every machine), the rollout (canary machines first, then the rest — the default for
 * runtimes — or all at once), how long offline machines may still take it (1–168 h) and, for machine-admin kinds,
 * the approval policy. Shows offline machines (queued) and machines that cannot take it. Starts through step-up
 * (always-fresh for machine-admin kinds).
 */

type Verb = 'update' | 'install' | 'remove';

/** The kinds an item allows: install paths (a tool may need an elevated path on some machines) and removal. */
export function kindsOf(
  item: CatalogItem,
  data: FleetTools,
): { install: ActionKind[]; remove: ActionKind | null } {
  if (item.kind === 'runtime') return { install: ['runtime.install'], remove: null };
  if (item.kind === 'custom') return { install: ['custom.install'], remove: 'custom.remove' };
  if (item.recipe === undefined) return { install: [], remove: null };
  const seen = new Set<ActionKind>();
  for (const m of data.machines) {
    const k = m.cells.find((c) => c.item === item.id)?.action?.kind;
    if (k === 'tool.install' || k === 'tool.elevated') seen.add(k);
  }
  const install: ActionKind[] =
    seen.size === 0
      ? ['tool.install']
      : (['tool.install', 'tool.elevated'] as const).filter((k) => seen.has(k));
  return { install, remove: 'tool.remove' };
}

function Radio(props: {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={props.onChange}
        aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
        className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[0.875rem] font-medium">
          {props.label}
        </label>
        {props.hint === undefined ? null : (
          <p id={`${id}-hint`} className="m-0 text-[0.78125rem] text-dy-muted">
            {props.hint}
          </p>
        )}
      </div>
    </div>
  );
}

function Group(props: { readonly legend: string; readonly children: ReactNode }): ReactNode {
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{props.legend}</legend>
      {props.children}
    </fieldset>
  );
}

export function BulkDialog(props: {
  readonly open: boolean;
  readonly data: FleetTools;
  readonly initialItem: string | null;
  readonly selected: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onStarted: (a: FleetAction) => void;
}): ReactNode {
  const { data } = props;
  const ft = useT().fleetTools;
  const t = ft.bulk;
  const words = useFleetWords();
  const firstItem = props.initialItem ?? data.catalog[0]?.id ?? '';
  const [itemId, setItemId] = useState(firstItem);
  const [verb, setVerb] = useState<Verb>('update');
  const [path, setPath] = useState<ActionKind | null>(null);
  const [version, setVersion] = useState('');
  const [target, setTarget] = useState<'selected' | 'all'>(props.selected.size > 0 ? 'selected' : 'all');
  const item = data.catalog.find((c) => c.id === itemId);
  const [rollout, setRollout] = useState<'all' | 'canary-first'>(
    item?.kind === 'runtime' ? 'canary-first' : 'all',
  );
  const [hours, setHours] = useState('24');
  const [approval, setApproval] = useState<'ask-all' | 'allow-all'>('ask-all');
  // p16-runtime-updates: install the newer version outside the pins, labelled unverified. Untouched (null), an update
  // takes the newer version: with the pin already installed, the pin alone is "nothing to do".
  const [unverifiedChoice, setUnverified] = useState<boolean | null>(null);
  const unverified = unverifiedChoice ?? verb === 'update';
  const tu = useT().runtimeUpdates;
  const submit = useSubmit();
  const guarded = useGuarded();

  if (item === undefined) return null;
  const kinds = kindsOf(item, data);
  const installKind = path !== null && kinds.install.includes(path) ? path : (kinds.install[0] ?? null);
  const kind: ActionKind | null = verb === 'remove' ? kinds.remove : installKind;
  const verbs: Verb[] = [
    ...(kinds.install.length > 0 ? (['update', 'install'] as const) : []),
    ...(kinds.remove === null ? [] : (['remove'] as const)),
  ];
  const available = [
    ...new Set(data.machines.flatMap((m) => m.cells.find((c) => c.item === item.id)?.available ?? [])),
  ];
  const versionOptions: (readonly [string, string])[] = [
    ['', item.pinned === null ? t.anyVersion : t.pinVersion({ pin: item.pinned })],
    ...(item.kind === 'runtime'
      ? available.filter((v) => v !== item.pinned).map((v) => [v, v] as const)
      : []),
  ];
  const targets =
    target === 'all' ? data.machines : data.machines.filter((m) => props.selected.has(m.workerId));
  // p16-runtime-updates: the newest version at the source when it is above every machine's pinned set.
  const offered =
    item.kind === 'runtime'
      ? (data.machines.flatMap((m) => {
          const v = m.cells.find((c) => c.item === item.id)?.unverifiedAction?.version;
          return v === undefined ? [] : [v];
        })[0] ?? null)
      : null;
  const newerOff =
    item.kind === 'runtime' &&
    offered === null &&
    data.policy?.unverifiedRuntimeUpdates === false &&
    item.latest !== null &&
    item.pinned !== null &&
    item.latest !== item.pinned &&
    !available.includes(item.latest)
      ? item.latest
      : null;
  const useUnverified = unverified && offered !== null && verb !== 'remove';
  const offline = targets.filter((m) => !m.connected);
  const blocked = targets.flatMap((m) => {
    const c = m.cells.find((x) => x.item === item.id);
    if (useUnverified) return [];
    return c?.blocked === undefined || c.action !== null || c.unverifiedAction !== undefined
      ? []
      : [{ m, why: words.blocked(c.blocked) }];
  });
  const h = Number(hours);
  const hoursBad = !Number.isInteger(h) || h < 1 || h > 168;
  const admin = kind !== null && isAdminAction(kind);
  const canStart = kind !== null && !hoursBad && (target === 'all' || props.selected.size > 0);

  const start = (): void => {
    if (kind === null) return;
    const body: NewAction = {
      kind,
      item: item.id,
      ...(useUnverified
        ? { version: offered, unverified: true }
        : version === '' || verb === 'remove'
          ? {}
          : { version }),
      workers: target === 'all' ? 'all' : [...props.selected],
      rollout,
      expiresInHours: h,
      ...(admin ? { approvalPolicy: approval } : {}),
    };
    void submit.run(async () => {
      const a = await guarded(
        () => startFleetAction(body),
        stepUpWhy(
          ft.parts,
          kind,
          t.why({
            item: item.label,
            verb: t.verbs[verb].toLocaleLowerCase(),
            target: target === 'all' ? t.allMachines : t.machineCount({ n: targets.length }),
          }),
        ),
      );
      if (a !== null) props.onStarted(a);
    });
  };

  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.description}
      // p17-ui-polish: a one-column form — the wide dialog left 50-character lines and a lone "2 makine" row.
      size="md"
      backdropClose={false}
      testId="bulk-dialog"
      footer={
        <FormActions>
          <DyButton variant="primary" busy={submit.busy} disabled={!canStart} onClick={start}>
            {t.start}
          </DyButton>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
        </FormActions>
      }
    >
      <div className="grid gap-4">
        <DySelect
          label={t.item}
          value={item.id}
          options={data.catalog.map((c) => [c.id, c.label] as const)}
          onChange={(v) => {
            setItemId(v);
            setVersion('');
            setPath(null);
            setVerb('update');
            const next = data.catalog.find((c) => c.id === v);
            setRollout(next?.kind === 'runtime' ? 'canary-first' : 'all');
          }}
        />
        {verbs.length === 0 ? (
          <DyNotice tone="neutral">{t.noRecipe}</DyNotice>
        ) : (
          <Group legend={t.action}>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {verbs.map((v) => (
                <Radio
                  key={v}
                  name="bulk-verb"
                  value={v}
                  checked={verb === v}
                  onChange={() => {
                    setVerb(v);
                  }}
                  label={t.verbs[v]}
                />
              ))}
            </div>
          </Group>
        )}
        {verb !== 'remove' && kinds.install.length > 1 ? (
          <Group legend={t.path}>
            <Radio
              name="bulk-path"
              value="tool.install"
              checked={installKind === 'tool.install'}
              onChange={() => {
                setPath('tool.install');
              }}
              label={t.pathOwn}
            />
            <Radio
              name="bulk-path"
              value="tool.elevated"
              checked={installKind === 'tool.elevated'}
              onChange={() => {
                setPath('tool.elevated');
              }}
              label={t.pathElevated}
            />
          </Group>
        ) : null}
        {verb === 'remove' || useUnverified ? null : (
          <DySelect label={t.version} value={version} options={versionOptions} onChange={setVersion} />
        )}
        {offered === null || verb === 'remove' ? null : (
          <div className="grid gap-1" data-testid="bulk-unverified">
            <DyCheck
              label={tu.bulk.unverified}
              hint={fill(tu.bulk.unverifiedHint, { version: offered })}
              checked={unverified}
              onChange={setUnverified}
              testId="bulk-unverified-toggle"
            />
            {useUnverified ? (
              <p className="m-0 text-[0.8125rem] font-bold" data-testid="bulk-unverified-version">
                {fill(tu.bulk.latest, { version: offered })}
              </p>
            ) : null}
          </div>
        )}
        {newerOff === null ? null : (
          <DyNotice tone="neutral" testId="bulk-unverified-off">
            {fill(tu.bulk.unverifiedOff, { version: newerOff })}
          </DyNotice>
        )}
        {item.kind === 'runtime' ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="bulk-runtime-note">
            {t.runtimeNoteBefore}{' '}
            <Link to="/settings/runtimes" className="font-medium text-dy-teal-ink">
              {t.runtimeNoteLink}
            </Link>{' '}
            {t.runtimeNoteAfter}
          </p>
        ) : null}
        <Group legend={t.target}>
          <Radio
            name="bulk-target"
            value="selected"
            checked={target === 'selected'}
            onChange={() => {
              setTarget('selected');
            }}
            label={t.selected({ n: props.selected.size })}
            hint={props.selected.size === 0 ? t.pickMachines : undefined}
          />
          <Radio
            name="bulk-target"
            value="all"
            checked={target === 'all'}
            onChange={() => {
              setTarget('all');
            }}
            label={t.all}
          />
        </Group>
        <Group legend={t.rollout}>
          <Radio
            name="bulk-rollout"
            value="canary-first"
            checked={rollout === 'canary-first'}
            onChange={() => {
              setRollout('canary-first');
            }}
            label={t.canaryFirst}
            hint={t.canaryHint}
          />
          <Radio
            name="bulk-rollout"
            value="all"
            checked={rollout === 'all'}
            onChange={() => {
              setRollout('all');
            }}
            label={t.allAtOnce}
          />
        </Group>
        <DyField
          label={t.hours}
          type="number"
          inputMode="numeric"
          min={1}
          max={168}
          value={hours}
          onChange={setHours}
          hint={t.hoursHint}
          error={hoursBad ? t.hoursBad : undefined}
        />
        {admin ? (
          <Group legend={t.approval}>
            <Radio
              name="bulk-approval"
              value="ask-all"
              checked={approval === 'ask-all'}
              onChange={() => {
                setApproval('ask-all');
              }}
              label={t.askAll}
              hint={t.askAllHint}
            />
            <Radio
              name="bulk-approval"
              value="allow-all"
              checked={approval === 'allow-all'}
              onChange={() => {
                setApproval('allow-all');
              }}
              label={t.allowAll}
              hint={t.allowAllHint}
            />
          </Group>
        ) : null}
        <div className="grid gap-2 text-[0.8125rem]" data-testid="bulk-targets">
          <p className="m-0">
            <span className="font-bold">{t.targets({ n: targets.length })}</span>
            {offline.length > 0 ? (
              <span className="text-dy-muted" data-testid="bulk-offline">
                {t.offline({ n: offline.length })}
              </span>
            ) : null}
          </p>
          {blocked.length > 0 ? (
            <DyNotice tone="amber" title={t.blockedTitle} testId="bulk-blocked">
              <ul className="m-0 list-none p-0">
                {blocked.map((b) => (
                  <li key={b.m.workerId}>
                    {b.m.name}: {b.why}
                  </li>
                ))}
              </ul>
            </DyNotice>
          ) : null}
        </div>
        {/* p16-runtime-updates: a 409 nothing_to_do lists every machine's reason (never swallowed). */}
        <SkippedReasons error={submit.error} machines={data.machines} />
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </DyDialog>
  );
}
