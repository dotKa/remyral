import { StepUpCancelledError, useStepUp } from '../stepup/StepUpProvider';
import { useSubmit } from './useSubmit';

/** Runs a privileged write through the step-up dialog; a cancelled dialog is not an error. */
export function usePrivileged(): {
  submit: ReturnType<typeof useSubmit>;
  run: (fn: () => Promise<void>, why: string) => void;
} {
  const stepUp = useStepUp();
  const submit = useSubmit();
  const run = (fn: () => Promise<void>, why: string): void => {
    void submit.run(async () => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  return { submit, run };
}
