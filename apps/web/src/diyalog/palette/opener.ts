import { createContext, useContext } from 'react';

/** p12-diyalog-cmdk: opens the command palette (provided by the Diyalog shell; null outside it). */
export const PaletteOpener = createContext<(() => void) | null>(null);

export function usePaletteOpener(): (() => void) | null {
  return useContext(PaletteOpener);
}

/** p12-diyalog-cmdk: router-state key of the palette's "Asistana sor" question (never in the URL). */
export const ASK_STATE_KEY = 'dyAsk';
