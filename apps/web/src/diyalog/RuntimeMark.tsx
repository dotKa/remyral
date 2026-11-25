import type { ReactNode } from 'react';
import { cx } from '../components/ui';

/**
 * p12-diyalog: the four runtimes' own colours (cc Claude Code · cx Codex · pi Pi · oc OpenCode) as a small rounded
 * square next to the name. The name is always written out; the colour only speeds up scanning.
 */
export type RuntimeCode = 'cc' | 'cx' | 'pi' | 'oc';

const BY_ID: Readonly<Record<string, RuntimeCode>> = {
  'claude-code': 'cc',
  claude: 'cc',
  cc: 'cc',
  codex: 'cx',
  cx: 'cx',
  pi: 'pi',
  opencode: 'oc',
  oc: 'oc',
};

const NAME: Readonly<Record<RuntimeCode, string>> = {
  cc: 'Claude Code', // i18n-ignore: product name
  cx: 'Codex', // i18n-ignore: product name
  pi: 'Pi', // i18n-ignore: product name
  oc: 'OpenCode', // i18n-ignore: product name
};

const SWATCH: Readonly<Record<RuntimeCode, string>> = {
  cc: 'bg-dy-cc',
  cx: 'bg-dy-cx',
  pi: 'bg-dy-pi',
  oc: 'bg-dy-oc',
};

/** `claude-code` → `cc`; null for unknown or retired runtimes (shown without a colour). */
export function runtimeCode(runtime: string | null | undefined): RuntimeCode | null {
  return runtime === null || runtime === undefined ? null : (BY_ID[runtime] ?? null);
}

export function runtimeDisplayName(runtime: string): string {
  const c = runtimeCode(runtime);
  return c === null ? runtime : NAME[c];
}

export function RuntimeMark(props: {
  readonly runtime: string;
  /** Show only the swatch (the name becomes its accessible label). */
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const code = runtimeCode(props.runtime);
  const name = runtimeDisplayName(props.runtime);
  const swatch = (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-[9px] shrink-0 rounded-[3px]',
        code === null ? 'bg-dy-line-2' : SWATCH[code],
      )}
    />
  );
  if (props.compact === true)
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        data-runtime={code ?? props.runtime}
        className={props.className}
      >
        {swatch}
      </span>
    );
  return (
    <span
      data-runtime={code ?? props.runtime}
      className={cx('inline-flex items-center gap-[5px] whitespace-nowrap', props.className)}
    >
      {swatch}
      {name}
    </span>
  );
}
