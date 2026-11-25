/**
 * p11-memory-layers (docs/design/p11-memory-layers.md §5, ADR-0043): agents' learned experience. Every runtime adapter
 * (Claude Code, Codex, Pi, OpenCode) reports the agent's answer text as an assistant `message` event; the master reads
 * `LESSON:` / `MEMORY:` lines from it with this parser — the same rule for every runtime — and files them in the
 * project's Memory suggestions inbox as typed proposals (lesson / fact). They are untrusted agent text: never accepted
 * automatically, rendered as data, secret-scanned and de-duplicated before a person sees them. Pure.
 */

export interface MemoryProposal {
  /** `LESSON:` → a lesson (scoped to the project + the runtime that learned it); `MEMORY:` → a project fact. */
  readonly type: 'lesson' | 'fact';
  readonly title: string;
  readonly content: string;
}

/** Proposals read from one message at most. */
export const MAX_PROPOSALS_PER_MESSAGE = 5;
export const MAX_PROPOSAL_CONTENT = 1_000;
export const MAX_PROPOSAL_TITLE = 120;
/** Longer messages are read only up to here (a proposal is a short line, not an essay). */
const MAX_SCAN = 64 * 1024;

// Upper-case keywords only, at the start of a line (optionally a list bullet or bold): "Memory: 4 GB" in prose or tool
// output does not count. Turkish spellings are accepted for people who ask agents to answer in Turkish.
const LINE =
  /^\s{0,3}(?:[-*•]\s+)?(?:\*\*)?(LESSON|MEMORY|DERS|HAFIZA|HAFIZA NOTU)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/u;
const FENCE = /^\s{0,3}(```|~~~)/u;

function tidy(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}…`;
}

/** `<title> — <body>` / `<title>: <body>`; without a separator the first words are the title. */
function split(text: string): { title: string; content: string } {
  const sep = /\s[—–-]\s|:\s/u.exec(text);
  if (sep !== null && sep.index >= 3 && sep.index <= MAX_PROPOSAL_TITLE) {
    const title = text.slice(0, sep.index).trim();
    const body = text.slice(sep.index + sep[0].length).trim();
    if (body.length >= 8) return { title, content: `${title}: ${body}` };
  }
  const first = text.split(/(?<=[.!?])\s/u)[0] ?? text;
  return { title: cut(first.replace(/[.!?]$/u, ''), MAX_PROPOSAL_TITLE), content: text };
}

/** `LESSON:` / `MEMORY:` lines of one assistant message, outside fenced code blocks, de-duplicated, at most 5. */
export function parseMemoryProposals(text: string): MemoryProposal[] {
  const out: MemoryProposal[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const raw of text.slice(0, MAX_SCAN).split(/\r?\n/u)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = LINE.exec(raw);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const body = tidy(m[2]);
    if (body.length < 8 || /^<.*>$/u.test(body)) continue;
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const { title, content } = split(body);
    out.push({
      type: m[1] === 'LESSON' || m[1] === 'DERS' ? 'lesson' : 'fact',
      title: cut(title, MAX_PROPOSAL_TITLE),
      content: cut(content, MAX_PROPOSAL_CONTENT),
    });
    if (out.length >= MAX_PROPOSALS_PER_MESSAGE) break;
  }
  return out;
}

/** Cheap pre-check (the master's inbox routes only such messages to the memory effect). */
export function hasMemoryProposals(text: string): boolean {
  return (
    /(?:^|\n)\s{0,3}(?:[-*•]\s+)?(?:\*\*)?(?:LESSON|MEMORY|DERS|HAFIZA)/u.test(text) &&
    parseMemoryProposals(text).length > 0
  );
}
