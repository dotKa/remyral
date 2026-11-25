import { useEffect, useState } from 'react';

/**
 * p12-diyalog Faz 3: "Ajana yaz" — a card asks the job page's message box to take some text (and focus). A tiny
 * per-job channel so the card does not need to know which page or box shows the job: whoever renders the job's "Ajana
 * yaz" box subscribes with `useAgentMessageSeed(jobId)` and puts `seed.text` in its field whenever `seed.n` changes.
 * Nothing is sent: the person still writes and sends the message (`POST /jobs/:id/messages`).
 */

export interface AgentMessageSeed {
  readonly text: string;
  /** Changes every time, so the same text asked for twice still refocuses the box. */
  readonly n: number;
}

type Listener = (seed: AgentMessageSeed) => void;

const listeners = new Map<string, Set<Listener>>();
let counter = 0;

/** Puts `text` into the "Ajana yaz" box of `jobId` (when one is on screen). Returns whether a box took it. */
export function writeToAgent(jobId: string, text: string): boolean {
  const set = listeners.get(jobId);
  if (set === undefined || set.size === 0) return false;
  counter += 1;
  const seed = { text, n: counter };
  for (const l of set) l(seed);
  return true;
}

/** True while some box of `jobId` listens (a card shows "Ajana yaz" only then). */
export function hasAgentBox(jobId: string): boolean {
  return (listeners.get(jobId)?.size ?? 0) > 0;
}

/** The latest text a card asked the job's message box to take, or null. */
export function useAgentMessageSeed(jobId: string): AgentMessageSeed | null {
  const [seed, setSeed] = useState<AgentMessageSeed | null>(null);
  useEffect(() => {
    let set = listeners.get(jobId);
    if (set === undefined) {
      set = new Set();
      listeners.set(jobId, set);
    }
    const l: Listener = (s) => {
      setSeed(s);
    };
    set.add(l);
    return () => {
      set.delete(l);
      if (set.size === 0) listeners.delete(jobId);
    };
  }, [jobId]);
  return seed;
}
