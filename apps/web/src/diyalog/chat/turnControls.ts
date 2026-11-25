import { createContext, useContext } from 'react';

/**
 * p16-chat-complete: what the conversation's rows may do to its turns — edit a message of the person, regenerate the
 * last answer (also with another engine / model), retry a failed last turn. Absent (null): read-only (a shared
 * reader, the home thread) — the rows show no such controls.
 */
export interface TurnControls {
  /** Messages the person may edit now (current user messages; none while a turn runs). */
  readonly editable: ReadonlySet<string>;
  /** The last answer (regenerate under it), or null. */
  readonly lastAnswerId: string | null;
  /** The error line of a failed / lost / stopped last turn (retry on it), or null. */
  readonly retryId: string | null;
  readonly editingId: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly startEdit: (id: string | null) => void;
  readonly edit: (id: string, text: string) => void;
  readonly regenerate: () => void;
  readonly regenerateOther: () => void;
  readonly retry: () => void;
}

export const TurnControlsContext = createContext<TurnControls | null>(null);

export function useTurnControls(): TurnControls | null {
  return useContext(TurnControlsContext);
}

/** p16-chat-complete: the conversation is shown to a shared reader (no stars, no edits, no card buttons). */
export const ReadOnlyContext = createContext(false);
