import { type ReactNode, useCallback, useState } from 'react';
import { cx } from '../components/ui';
import { DyIcon } from './icons';

/**
 * p17-panel-motion (docs/design/p17-panel-motion.md §3.3): the feedback of an authenticator code field — the website
 * scene's six digits filling in, in the real field. Purely visual (aria-hidden): the field, its label, its error text
 * and the step-up rules are unchanged.
 *
 *   CodeTicks  six ticks over the field's lower edge that fill as the digits come in (teal), turn red for a refused
 *              code and green for an accepted one
 *   CodeCheck  the check that pops in at the field's end once the code was accepted
 *   useShake   one short shake of the field for a wrong code (`data-shake`, restarts on every wrong code)
 */

export type CodeState = 'idle' | 'error' | 'ok';

export function CodeTicks(props: { readonly n: number; readonly state: CodeState }): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="code-ticks"
      data-state={props.state}
      className="dy-m-ticks pointer-events-none absolute inset-x-3 bottom-[4px] flex gap-1"
    >
      {Array.from({ length: 6 }, (_, i) => {
        const on = i < props.n || props.state === 'ok';
        return (
          <i
            key={i}
            data-on={on ? '' : undefined}
            className={cx(
              'h-[2px] flex-1 rounded-full',
              props.state === 'error'
                ? 'bg-dy-red'
                : props.state === 'ok'
                  ? 'bg-dy-green'
                  : on
                    ? 'bg-dy-teal'
                    : 'bg-dy-line-2',
            )}
          />
        );
      })}
    </span>
  );
}

export function CodeCheck(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="code-check"
      className="pointer-events-none absolute inset-y-0 right-2 grid place-items-center text-dy-green"
    >
      <DyIcon name="check" className="dy-m-check size-4" />
    </span>
  );
}

/** A shake for a wrong code: call `shake()`; spread `{ 'data-shake': attr }` on the field's wrapper. */
export function useShake(): { readonly shake: () => void; readonly attr: 'a' | 'b' | undefined } {
  const [n, setN] = useState(0);
  const shake = useCallback(() => {
    setN((x) => x + 1);
  }, []);
  return { shake, attr: n === 0 ? undefined : n % 2 === 1 ? 'a' : 'b' };
}
