import { createContext, useContext } from 'react';

/**
 * p15-chat-cards-scroll: what a card inside the Sohbet thread may ask of the conversation around it — the job result
 * card's "Düzelt" puts a request into the composer (nothing is sent until the person sends it), "Yeniden çalıştır"
 * drafts a card in this conversation and reloads it. Absent outside a conversation (the card then hides those actions).
 */
export interface ChatActions {
  readonly threadId: string;
  /** Puts `text` into the composer and focuses it. */
  readonly ask: (text: string) => void;
  /** Re-reads the conversation (a new card appeared). */
  readonly reload: () => void;
  /**
   * p17-chat-flow: "Sohbette düzenle" — the composer starts a change request for this workflow card (its next message
   * carries the card's id; the assistant's new card replaces it). Absent: the card hides the button.
   */
  readonly editDraft?: (draft: { readonly id: string; readonly title: string }) => void;
  /** p18-plan-mode: sends a message (the planning proposal's buttons); `plan`: in plan mode. Absent: no buttons. */
  readonly send?: (text: string, opts?: { readonly plan?: boolean }) => Promise<void>;
  /** p18-plan-mode: opens the plan panel on the conversation's plan ("Planı incele"). */
  readonly openPlan?: () => void;
  /** p18-plan-mode: the answering machine has the plan tools (else the "Planla" choice is off). */
  readonly planReady?: boolean;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions | null {
  return useContext(ChatActionsContext);
}
