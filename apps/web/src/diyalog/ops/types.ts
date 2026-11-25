import type { ReactNode } from 'react';
import type { OpsItem } from '../../api/opsThread';

/** p12-diyalog Faz 1: what every live card of the operations thread receives (registry.ts `render`). */
export interface CardProps<T> {
  readonly item: OpsItem & { readonly type: T };
  /** "1 / 5" among the open decisions, when it is one. */
  readonly position?: string | undefined;
  /** The entity changed here (decided): the thread keeps the new state until the next poll confirms it. */
  readonly onChanged: (next: OpsItem) => void;
  /** A draft was made in the ops chat: reload it. */
  readonly onChat: () => void;
  readonly dismissed?: boolean | undefined;
  readonly onDismiss?: ((key: string) => void) | undefined;
  /** p12-diyalog Faz 3: in a job thread, "Ajana yaz" opens the job composer prefilled about this request. */
  readonly onWriteAgent?: (() => void) | undefined;
  /** p20-decisions: more of the same decision drawn inside the card (a job page's merge approval: its changes). */
  readonly extra?: ReactNode;
}

/** Any card: the registry renders the item through its type's renderer. */
export type OpsCardProps = CardProps<OpsItem['type']>;
