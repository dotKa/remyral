import {
  type ComponentType,
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { DyStepUpDialog } from '../diyalog/DyStepUpDialog';

export class StepUpCancelledError extends Error {
  override readonly name = 'StepUpCancelledError';
  constructor() {
    super('Step-up confirmation was cancelled.');
  }
}

export function isStepUpRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code === 'step_up_required';
}

interface StepUpContextValue {
  /** Asks for a fresh TOTP; resolves true when verified, false when cancelled. */
  confirm(reason?: string): Promise<boolean>;
  /**
   * Runs a privileged action. If the master answers `403 step_up_required`, opens the dialog and retries
   * once after a successful confirmation; throws {@link StepUpCancelledError} if the user cancels.
   */
  run<T>(action: () => Promise<T>, reason?: string): Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

/** The dialog contract the StepUpProvider renders (DyStepUpDialog unless a caller passes another). */
export interface StepUpDialogProps {
  readonly open: boolean;
  readonly reason?: string;
  readonly verify: (code: string) => Promise<void>;
  readonly onVerified: () => void;
  readonly onCancel: () => void;
}

export function StepUpProvider(props: {
  readonly children: ReactNode;
  /** p12-diyalog-w4: the dialog to render (default: the Diyalog step-up dialog); the rules here are the same. */
  readonly dialog?: ComponentType<StepUpDialogProps> | undefined;
}): ReactNode {
  const Dialog = props.dialog ?? DyStepUpDialog;
  const { actions } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setOpen(false);
    const resolve = pending.current;
    pending.current = null;
    resolve?.(ok);
  }, []);

  const confirm = useCallback((why?: string): Promise<boolean> => {
    pending.current?.(false); // a newer request supersedes an open one
    setReason(why);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, why?: string): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isStepUpRequired(err)) throw err;
        if (!(await confirm(why))) throw new StepUpCancelledError();
        return action();
      }
    },
    [confirm],
  );

  const value = useMemo(() => ({ confirm, run }), [confirm, run]);

  return (
    <StepUpContext value={value}>
      {props.children}
      <Dialog
        open={open}
        {...(reason === undefined ? {} : { reason })}
        verify={async (code) => {
          await actions.stepUp(code);
        }}
        onVerified={() => {
          settle(true);
        }}
        onCancel={() => {
          settle(false);
        }}
      />
    </StepUpContext>
  );
}

/**
 * p15-form-pattern: the step-up runner when a provider is mounted, null otherwise (the shared form parts run their
 * save through it when it exists; a bare component test without the provider simply saves).
 */
export function useOptionalStepUp(): StepUpContextValue | null {
  return use(StepUpContext);
}

export function useStepUp(): StepUpContextValue {
  const ctx = use(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return ctx;
}
