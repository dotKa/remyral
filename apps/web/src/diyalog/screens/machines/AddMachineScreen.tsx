import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  getInstallers,
  type InstallerOs,
  type InstallerOverview,
  kitDownloadPath,
} from '../../../api/installers';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { bundleSteps, NODE_HOME, PLATFORMS } from '../../../screens/fleet/addMachine';
import { cx } from '../../../components/ui';
import { DyIcon } from '../../icons';
import { DyCopyButton, DyNotice } from '../forms';
import { ErrorLine, Panel, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3): `/machines/add` in the Diyalog language — feature for feature with the classic
 * `AddMachinePage` (p5-worker-onboarding, docs/ops/worker-pairing.md §1): pick the system, run the two-line command
 * (download + SHA-256 check of the bootstrap, then run it) or download the signed installer bundle and install from
 * it; the machine then waits to pair on the machine list. Read only: the same `GET /installers`, the same commands
 * and bundle path (the classic `PLATFORMS`, `bundleSteps`, `NODE_HOME`); nothing is trusted before the fingerprint
 * check and the pairing code. Owners and admins only (the master refuses the rest).
 */

// Product and platform names: the same in every language.
const OS_WORD: Readonly<Record<InstallerOs, string>> = {
  linux: 'Linux', // i18n-ignore
  macos: 'macOS', // i18n-ignore
  windows: 'Windows', // i18n-ignore
};

/** The platform note's catalog key (same facts as the classic `PLATFORMS[].note`). */
const NOTE: Readonly<Record<string, 'linuxX64' | 'linuxArm64' | 'macos' | 'windows'>> = {
  'linux-x64': 'linuxX64',
  'linux-arm64': 'linuxArm64',
  'darwin-arm64': 'macos',
  'darwin-x64': 'macos',
  'win-x64': 'windows',
};

const LABEL: Readonly<Record<string, string>> = {
  'linux-x64': 'Linux x64', // i18n-ignore
  'linux-arm64': 'Linux arm64 / Raspberry Pi', // i18n-ignore
  'darwin-arm64': 'macOS (Apple silicon)', // i18n-ignore
  'darwin-x64': 'macOS (Intel)', // i18n-ignore
  'win-x64': 'Windows x64', // i18n-ignore
};

function Step(props: {
  readonly n: number;
  readonly title: string;
  readonly aside?: ReactNode;
  readonly sub?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}): ReactNode {
  const t = useT().machines.add;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full bg-dy-ink font-dy-mono text-[0.75rem] font-bold text-dy-card"
          >
            {props.n}
          </span>
          <span>
            <span className="sr-only">{t.step({ n: props.n })}</span>
            {props.title}
          </span>
        </span>
      }
      aside={props.aside}
      sub={props.sub}
      testId={props.testId}
    >
      {props.children}
    </Panel>
  );
}

/** The system picker: a radio group in the segmented-tab shape, arrow keys move and select (WAI-ARIA radio). */
function SystemPicker(props: { readonly value: string; readonly onChange: (id: string) => void }): ReactNode {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const t = useT().machines.add;
  const idx = PLATFORMS.findIndex((p) => p.id === props.value);
  const move = (next: number): void => {
    const n = (next + PLATFORMS.length) % PLATFORMS.length;
    const p = PLATFORMS[n];
    if (p === undefined) return;
    props.onChange(p.id);
    refs.current[n]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t.system}
      className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(idx + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(idx - 1);
        }
      }}
    >
      {PLATFORMS.map((p, i) => {
        const on = p.id === props.value;
        return (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => {
              props.onChange(p.id);
            }}
            className={cx(
              'dy-press flex min-h-11 items-center gap-2 rounded-[10px] border px-3 text-left text-[0.875rem]',
              on
                ? 'border-dy-ink bg-dy-ink font-bold text-dy-card'
                : 'border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
            )}
          >
            <DyIcon name={on ? 'checkc' : 'cpu'} className="size-4 shrink-0" />
            <span className="min-w-0">
              {LABEL[p.id] ?? p.label}
              <span className={cx('block text-[0.75rem] font-normal', on ? 'opacity-75' : 'text-dy-muted')}>
                {OS_WORD[p.os]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A command: its label with the copy button on one line, the command under it (full width, wraps anywhere). */
function CommandBlock(props: { readonly label: string; readonly text: string }): ReactNode {
  const t = useT().machines.add;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-bold">{props.label}</span>
        <DyCopyButton text={props.text} about={t.copy({ label: props.label })} />
      </div>
      <code className="block min-w-0 rounded-[9px] border border-dy-line bg-dy-sunk px-3 py-2 font-dy-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-dy-ink [overflow-wrap:anywhere]">
        {props.text}
      </code>
    </div>
  );
}

export function AddMachineScreen(): ReactNode {
  const { state: auth } = useAuth();
  const t = useT().machines.add;
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const [data, setData] = useState<InstallerOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [platformId, setPlatformId] = useState(PLATFORMS[0]?.id ?? 'linux-x64');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    setError(null);
    getInstallers().then(
      (d) => {
        if (live) setData(d);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [isAdmin, attempt]);

  const platform = PLATFORMS.find((p) => p.id === platformId) ?? PLATFORMS[0];
  const frame = (children: ReactNode): ReactNode => (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      back={{ to: '/machines', label: t.back }}
      width="narrow"
      testId="dy-add-machine"
    >
      {children}
    </ScreenFrame>
  );
  if (!isAdmin)
    return frame(
      <DyNotice tone="neutral" testId="add-machine-admin-only">
        {t.adminOnly}
      </DyNotice>,
    );
  if (platform === undefined) return frame(null);
  const cur = data?.current ?? null;
  const kit = cur?.kits.find((k) => k.os === platform.os) ?? null;
  const label = LABEL[platform.id] ?? platform.label;

  return frame(
    <div className="flex flex-col gap-4">
      <ErrorLine
        error={error}
        what={t.kits}
        onRetry={() => {
          setAttempt((n) => n + 1);
        }}
      />

      <Step
        n={1}
        title={t.system}
        sub={NOTE[platform.id] === undefined ? platform.note : t.notes[NOTE[platform.id] ?? 'linuxX64']}
      >
        <SystemPicker value={platform.id} onChange={setPlatformId} />
      </Step>

      {data === null && error === null ? (
        <Panel title={t.install} flush>
          <SkeletonRows label={t.kitsLoading} rows={6} />
        </Panel>
      ) : null}

      {data !== null && cur === null ? (
        <DyNotice tone="amber" title={t.noKitsTitle} testId="no-kits">
          {t.noKitsBefore}{' '}
          <code className="font-dy-mono">
            node scripts/release/sign.mjs installers --dir dist/release/&lt;version&gt; --key …
          </code>{' '}
          {t.noKitsAfter}{' '}
          <Link to="/settings/releases" className="font-medium text-dy-ink">
            {t.releases}
          </Link>
          ).
        </DyNotice>
      ) : null}

      {cur !== null ? (
        <Step
          n={2}
          title={t.installStep}
          testId="install-step"
          sub={
            <>
              {t.software} <span className="font-dy-mono">{cur.version}</span> (
              {cur.stable ? t.stable : t.channel({ channel: cur.channel })}) {t.signedBefore}{' '}
              <span className="font-dy-mono">{cur.keyId}</span> {t.signedAfter}
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {!cur.stable ? <DyNotice tone="amber">{t.notStable}</DyNotice> : null}
            {kit === null ? (
              <DyNotice tone="amber">{t.noKit({ platform: label })}</DyNotice>
            ) : (
              <>
                {kit.commands !== null ? (
                  <div className="flex flex-col gap-3" data-testid="install-commands">
                    <p className="m-0 text-[0.875rem]">
                      {t.runIntro({ windows: platform.os === 'windows' })}
                    </p>
                    <CommandBlock label={t.download} text={kit.commands.download} />
                    <CommandBlock label={t.run} text={kit.commands.run} />
                  </div>
                ) : (
                  <DyNotice tone="neutral">
                    {data?.publicOrigin === null ? t.noOrigin : t.downloadsOff} {t.useBundle}
                  </DyNotice>
                )}
                <div className="flex flex-col gap-3 border-t border-dy-line pt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={kitDownloadPath(cur.version, platform.os)}
                      download={kit.file}
                      className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
                    >
                      <DyIcon name="tray" className="size-4" />
                      {t.downloadBundle}
                    </a>
                    <span className="min-w-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
                      <span className="font-dy-mono">{kit.file}</span> ·{' '}
                      {(kit.sizeBytes / 1024 / 1024).toFixed(1)} MiB
                    </span>
                  </div>
                  <p
                    className="m-0 font-dy-mono text-[0.78125rem] break-all text-dy-muted"
                    data-testid="kit-sha256"
                  >
                    SHA-256 {kit.sha256}
                  </p>
                  {data?.masterUrl !== null && data?.masterUrl !== undefined ? (
                    <CommandBlock label={t.fromBundle} text={bundleSteps(kit, data.masterUrl)} />
                  ) : null}
                </div>
                <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="node-note">
                  {t.nodeBefore}{' '}
                  <span className="font-dy-mono">
                    node-v{cur.nodeVersion}-{platform.node}
                  </span>{' '}
                  {t.nodeMiddle} <span className="font-dy-mono">{NODE_HOME[platform.os]}</span> {t.nodeAfter}
                </p>
              </>
            )}
          </div>
        </Step>
      ) : null}

      <Step n={3} title={t.approveStep}>
        <p className="m-0 text-[0.875rem]">
          {t.approveBefore} <strong>{t.pairingCode}</strong> {t.and} <strong>{t.fingerprint}</strong>{' '}
          {t.approveMiddle}{' '}
          <Link to="/machines" className="font-medium text-dy-ink">
            {t.approveLink}
          </Link>{' '}
          {t.approveAfter}
        </p>
      </Step>
    </div>,
  );
}
