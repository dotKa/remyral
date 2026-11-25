import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';
import { insideModal, toast } from './toast/store';

/**
 * p12-diyalog: the exact command an agent wants to run, on a dark plate in mono with a `$` prompt and a copy
 * button. Wraps instead of scrolling sideways (a decision needs the whole command in view). The copy result is a
 * toast (p17-toasts-shortcuts) — inside a modal dialog it is announced in place, as before (the toaster is under the
 * modal); the button's own label turns into "Kopyalandı" for a moment.
 */
export function CodeBlock(props: {
  readonly code: string;
  /** Shell prompt shown before the first line; null for plain output. */
  readonly prompt?: string | null | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT().shared.copy;
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [inline, setInline] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => {
      setCopied(null);
    }, 1800);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const prompt = props.prompt === undefined ? '$' : props.prompt;
  const copy = async (): Promise<void> => {
    const modal = insideModal(root.current);
    setInline(modal);
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied('ok');
      if (!modal) toast.success(t.commandCopied, { id: 'copied', testId: 'dy-copied' });
    } catch {
      setCopied('fail');
      if (!modal) toast.error(t.failedShort, { id: 'copied', testId: 'dy-copy-failed' });
    }
  };
  return (
    <div
      ref={root}
      className={cx(
        'flex min-w-0 items-start gap-2.5 rounded-[10px] border border-dy-cmd-line bg-dy-cmd px-3 py-2.5 font-dy-mono text-[0.8125rem] leading-normal text-dy-cmd-ink',
        props.className,
      )}
    >
      {prompt === null ? null : (
        <span aria-hidden="true" className="text-[#7fd6d9] select-none">
          {prompt}
        </span>
      )}
      <code translate="no" className="min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap">
        {props.code}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="dy-press flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-xs text-[#c9d2e3] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/15"
      >
        <DyIcon name={copied === 'ok' ? 'check' : 'copy'} className="size-3.5" />
        {copied === 'ok' ? t.copiedShort : t.label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {!inline ? '' : copied === 'ok' ? t.commandCopied : copied === 'fail' ? t.failedShort : ''}
      </span>
    </div>
  );
}
