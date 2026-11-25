import { classifyCommand, MAX_SAFE_COMMAND_LENGTH, type SafeVerdict } from './safe-commands/index.js';

/**
 * p10-approval-readable (docs/design/p10-approval-readable.md): the structured, bounded fields of a runtime tool call
 * that asks for a human approval, and the deterministic readings the console shows next to them. Pure and zod-free:
 * the adapters extract the fields (after parsing the tool input, then per field: redact, clean, clip), the master
 * validates and stores them and derives the "what this touches" hints, and the console formats the command.
 *
 * Every string here is untrusted runtime/agent text. The hints are a static reading of the command text for a human,
 * never an input to a decision (the safe-command auto-approval keeps its own strict classifier).
 */

export const APPROVAL_DETAIL_LIMITS = {
  tool: 128,
  /** The agent's own one-line explanation (Claude Code `description`, Codex `reason`, …). */
  description: 1_000,
  /** The full command, unescaped (16 KiB). */
  command: 16 * 1024,
  cwd: 1_024,
  path: 1_024,
  /** At most this many paths; the rest is counted in `morePaths`. */
  paths: 20,
  url: 2_048,
} as const;

export const APPROVAL_SHELLS = ['posix', 'powershell', 'cmd'] as const;
export type ApprovalShell = (typeof APPROVAL_SHELLS)[number];

/** What a runtime said it wants to run, field by field (APPROVAL_REQUEST event `details`, protocol 1.0 additive). */
export interface ApprovalDetails {
  /** The runtime's tool name (`Bash`, `PowerShell`, `shell`, `Edit`, `bash`, …). */
  readonly tool: string;
  /** The agent's own explanation of the call (unverified claim), one line. */
  readonly description?: string;
  /** The command to run, as the shell will see it (newlines kept, JSON escapes resolved). */
  readonly command?: string;
  /** `command` was longer than {@link APPROVAL_DETAIL_LIMITS.command} and is cut. */
  readonly commandTruncated?: boolean;
  /** Which shell runs `command`, when the runtime says so. */
  readonly shell?: ApprovalShell;
  /** Working directory the runtime names for this call. */
  readonly cwd?: string;
  /** The job's workspace root on the machine (for "outside the workspace" readings). */
  readonly workspaceRoot?: string;
  /** File paths the call names (file tools, patches). */
  readonly paths?: string[];
  /** Paths beyond the first {@link APPROVAL_DETAIL_LIMITS.paths}. */
  readonly morePaths?: number;
  /** A URL the call names (fetch tools). */
  readonly url?: string;
}

// ------------------------------------------------------------------------------------------------ text hygiene

/** Bidirectional overrides / isolates and zero-width characters: they can make displayed text lie (Trojan Source). */

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
const CONTROL_MULTI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
const CONTROL_ONE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function visible(s: string): string {
  return s.replace(INVISIBLE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

/** One line: control characters and runs of whitespace become one space; invisible characters are made visible. */
export function oneLine(s: string): string {
  return visible(s.replace(CONTROL_ONE, ' ')).replace(/\s+/g, ' ').trim();
}

/** Several lines: CR/LF normalised to LF, other control characters dropped, invisible characters made visible. */
export function multiLine(s: string): string {
  return visible(
    s
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL_MULTI, '')
      .replace(/[\u2028\u2029]/g, '\n'),
  );
}

/** At most `max` UTF-16 units, marked with `…` when cut, never splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

// ------------------------------------------------------------------------------------------------ extraction

const SHELL_TOOLS = new Set([
  'bash',
  'powershell',
  'shell',
  'exec',
  'sh',
  'cmd',
  'local_shell',
  'run_shell_command',
]);
const SHELL_BINARIES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-ic', '-command', '-c', '/c', '/k', '-encodedcommand']);

const DESCRIPTION_KEYS = ['description', 'reason', 'justification'] as const;
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;
const CWD_KEYS = ['cwd', 'workdir', 'working_directory', 'workingDirectory', 'directory'] as const;
const PATH_KEYS = ['file_path', 'filePath', 'filepath', 'notebook_path', 'path', 'target_file'] as const;
const PATH_LIST_KEYS = ['paths', 'file_paths', 'files'] as const;
const URL_KEYS = ['url', 'uri'] as const;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function quoteArg(a: string): string {
  return a === '' || /[\s"'`$;&|<>()]/.test(a) ? `"${a.replace(/(["\\$`])/g, '\\$1')}"` : a;
}

/**
 * The command of an argv array: the script of `bash -lc SCRIPT` / `pwsh -NoProfile -Command SCRIPT` / `cmd /c …`,
 * else the words joined with quotes where needed.
 */
export function commandFromArgv(argv: readonly string[]): string {
  const first = argv[0];
  if (
    first !== undefined &&
    SHELL_BINARIES.has(
      baseName(first)
        .toLowerCase()
        .replace(/\.exe$/, ''),
    )
  ) {
    const at = argv.findIndex((a, i) => i > 0 && SHELL_COMMAND_FLAGS.has(a.toLowerCase()));
    if (at > 0 && at < argv.length - 1) {
      const rest = argv.slice(at + 1);
      return rest.length === 1 ? (rest[0] ?? '') : rest.join(' ');
    }
  }
  return argv.map(quoteArg).join(' ');
}

function pick(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function parseInput(input: unknown): Record<string, unknown> | string | null {
  if (input !== null && typeof input === 'object' && !Array.isArray(input))
    return input as Record<string, unknown>;
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t);
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null; // truncated or invalid JSON: never shown as a command
    }
  }
  return t === '' ? null : input;
}

export interface ExtractOptions {
  /** Secret redaction (the job's exact secret values); runs on each whole field before it is cleaned and clipped. */
  readonly redact?: (text: string) => string;
  /** Which shell runs the command, when the adapter knows. */
  readonly shell?: ApprovalShell;
  readonly workspaceRoot?: string;
  /** Runtime-specific fields found outside the tool input (they win over the input's own keys). */
  readonly description?: string | null;
  readonly command?: string | readonly string[] | null;
  readonly cwd?: string | null;
  readonly paths?: readonly string[];
  readonly url?: string | null;
}

/**
 * The structured fields of one tool call. `input` is the tool input as the runtime reported it: an object, or a JSON
 * text (parsed first; a cut or invalid JSON text yields no command — never a half-parsed one), or for a shell tool the
 * plain command text. Truncation happens per field after parsing.
 */
export function extractApprovalDetails(
  tool: string,
  input: unknown,
  opts: ExtractOptions = {},
): ApprovalDetails {
  const redact = opts.redact ?? ((s: string) => s);
  const parsed = parseInput(input);
  const obj = typeof parsed === 'object' && parsed !== null ? parsed : null;
  const shellTool = SHELL_TOOLS.has(tool.toLowerCase());

  let description = opts.description ?? (obj === null ? undefined : pick(obj, DESCRIPTION_KEYS));
  let command: string | undefined;
  const rawCommand = opts.command ?? (obj === null ? undefined : (obj.command ?? pick(obj, COMMAND_KEYS)));
  if (typeof rawCommand === 'string' && rawCommand.trim() !== '') command = rawCommand;
  else if (
    Array.isArray(rawCommand) &&
    rawCommand.every((a) => typeof a === 'string') &&
    rawCommand.length > 0
  )
    command = commandFromArgv(rawCommand);
  else if (obj === null && typeof parsed === 'string' && shellTool) command = parsed;
  const cwd = opts.cwd ?? (obj === null ? undefined : pick(obj, CWD_KEYS));
  const url = opts.url ?? (obj === null ? undefined : pick(obj, URL_KEYS));

  const rawPaths: string[] = [...(opts.paths ?? [])];
  if (obj !== null) {
    const single = pick(obj, PATH_KEYS);
    if (single !== undefined) rawPaths.push(single);
    for (const k of PATH_LIST_KEYS) {
      const v = obj[k];
      if (Array.isArray(v)) for (const p of v) if (typeof p === 'string' && p.trim() !== '') rawPaths.push(p);
    }
  }
  const paths = [
    ...new Set(rawPaths.map((p) => clip(oneLine(redact(p)), APPROVAL_DETAIL_LIMITS.path))),
  ].filter((p) => p !== '');

  if (description !== undefined)
    description = clip(oneLine(redact(description)), APPROVAL_DETAIL_LIMITS.description);
  let commandTruncated = false;
  if (command !== undefined) {
    const clean = multiLine(redact(command)).replace(/^\n+|\s+$/g, '');
    commandTruncated = clean.length > APPROVAL_DETAIL_LIMITS.command;
    command = clip(clean, APPROVAL_DETAIL_LIMITS.command);
  }
  const shell = opts.shell ?? (command !== undefined ? guessShell(tool, command) : undefined);
  const out: {
    -readonly [K in keyof ApprovalDetails]: ApprovalDetails[K];
  } = { tool: clip(oneLine(tool), APPROVAL_DETAIL_LIMITS.tool) || 'tool' };
  if (description !== undefined && description !== '') out.description = description;
  if (command !== undefined && command !== '') {
    out.command = command;
    if (commandTruncated) out.commandTruncated = true;
    if (shell !== undefined) out.shell = shell;
  }
  if (cwd !== undefined) out.cwd = clip(oneLine(redact(cwd)), APPROVAL_DETAIL_LIMITS.cwd);
  if (opts.workspaceRoot !== undefined && opts.workspaceRoot !== '')
    out.workspaceRoot = clip(oneLine(opts.workspaceRoot), APPROVAL_DETAIL_LIMITS.cwd);
  if (paths.length > 0) {
    out.paths = paths.slice(0, APPROVAL_DETAIL_LIMITS.paths);
    if (paths.length > APPROVAL_DETAIL_LIMITS.paths)
      out.morePaths = paths.length - APPROVAL_DETAIL_LIMITS.paths;
  }
  if (url !== undefined) out.url = clip(oneLine(redact(url)), APPROVAL_DETAIL_LIMITS.url);
  return out;
}

/** True when the details carry something beyond the tool name (worth sending / showing). */
export function hasApprovalDetails(d: ApprovalDetails | null | undefined): d is ApprovalDetails {
  return (
    d != null &&
    (d.description !== undefined ||
      d.command !== undefined ||
      d.cwd !== undefined ||
      (d.paths !== undefined && d.paths.length > 0) ||
      d.url !== undefined)
  );
}

/** Best guess of the shell when the runtime does not say (display and hints only). */
export function guessShell(tool: string, command: string): ApprovalShell {
  const t = tool.toLowerCase();
  if (t.includes('powershell') || t === 'pwsh') return 'powershell';
  if (t === 'cmd') return 'cmd';
  if (/\$env:|\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\$null\b|`n/.test(command)) return 'powershell';
  return 'posix';
}

// ------------------------------------------------------------------------------------------------ splitting

/** One top-level piece of a command line and the separator that ended it (`;`, `&&`, `||`, `|`, `&`, newline). */
export interface CommandSegment {
  readonly text: string;
  readonly sep: string | null;
}

/**
 * Splits a command at its top-level separators (outside quotes, parentheses, braces and brackets) for display. A
 * tolerant reading: it never fails, and nothing decides on it.
 */
export function splitCommand(command: string, shell: ApprovalShell = 'posix'): CommandSegment[] {
  const out: CommandSegment[] = [];
  let depth = 0;
  let start = 0;
  let quote: '"' | "'" | null = null;
  const escapeChar = shell === 'powershell' ? '`' : shell === 'cmd' ? '^' : '\\';
  const push = (end: number, sep: string | null, next: number): void => {
    const text = command.slice(start, end).trim();
    if (text !== '') out.push({ text, sep });
    else if (sep !== null && sep !== '\n' && out.length > 0) {
      const last = out[out.length - 1];
      if (last !== undefined && last.sep === '\n') out[out.length - 1] = { text: last.text, sep };
    }
    start = next;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (c === escapeChar && quote === '"' && shell !== 'cmd') i++;
      else if (c === quote) {
        if (shell === 'powershell' && command[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === escapeChar && shell !== 'cmd') {
      i++;
      continue;
    }
    if (c === '"' || (c === "'" && shell !== 'cmd')) {
      quote = c;
      continue;
    }
    if (c === '#' && shell !== 'cmd' && (i === 0 || /[\s;|&({]/.test(command[i - 1] ?? ''))) {
      // A comment runs to the end of the line.
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length - 1 : nl - 1;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    if (c === '\n') push(i, '\n', i + 1);
    else if (c === ';') push(i, ';', i + 1);
    else if ((c === '&' || c === '|') && command[i + 1] === c) {
      push(i, c + c, i + 2);
      i++;
    } else if (c === '|') push(i, '|', i + 1);
    else if (c === '&' && shell !== 'powershell') {
      // `2>&1`, `&>` and `>&` are redirections, not separators.
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === '>' || next === '>' || prev === '<') continue;
      push(i, '&', i + 1);
    }
  }
  push(command.length, null, command.length);
  return out;
}

/** The command broken at its top-level separators, one piece per line (pipes and `&&`/`||` continuations indented). */
export function formatCommand(command: string, shell: ApprovalShell = 'posix'): string {
  const segs = splitCommand(command, shell);
  const lines: string[] = [];
  let indent = false;
  for (const s of segs) {
    const tail = s.sep === null || s.sep === '\n' ? '' : ` ${s.sep}`;
    lines.push(`${indent ? '  ' : ''}${s.text}${tail}`);
    indent = s.sep === '|' || s.sep === '&&' || s.sep === '||';
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ headline

export interface ApprovalHeadline {
  readonly text: string;
  /** `agent`: the agent's own description (unverified); `command`: from the command / path; `summary`: legacy text. */
  readonly source: 'agent' | 'command' | 'summary';
}

/** One readable line for lists and notifications: the agent's description, else the first command piece, else the summary. */
export function approvalHeadline(
  details: ApprovalDetails | null | undefined,
  summary: string,
  max = 200,
): ApprovalHeadline {
  if (details?.description !== undefined && details.description !== '')
    return { text: clip(oneLine(details.description), max), source: 'agent' };
  if (details?.command !== undefined && details.command !== '') {
    const first = splitCommand(
      details.command,
      details.shell ?? guessShell(details.tool, details.command),
    )[0];
    const text = oneLine(first?.text ?? details.command);
    if (text !== '') return { text: clip(`${details.tool}: ${text}`, max), source: 'command' };
  }
  const path = details?.paths?.[0] ?? details?.url;
  if (details !== null && details !== undefined && path !== undefined)
    return { text: clip(`${details.tool}: ${path}`, max), source: 'command' };
  return { text: clip(oneLine(summary), max), source: 'summary' };
}

// ------------------------------------------------------------------------------------------------ hints

/** Deterministic, static reading of what a call touches (not a guarantee; shown as neutral facts). */
export interface ApprovalHints {
  /** Programs and cmdlets invoked (first word of each command, wrappers like sudo included). */
  readonly runs: string[];
  /** URLs / hosts named. */
  readonly reaches: string[];
  /** Files or folders written or created (redirections, Out-File, New-Item, cp/mv targets, …). */
  readonly writes: string[];
  /** Files or folders removed. */
  readonly deletes: string[];
  /** Package installs. */
  readonly installs: string[];
  /** Environment variables read. */
  readonly envVars: string[];
  /** Paths outside the job workspace (or absolute paths when the workspace is unknown). */
  readonly outside: string[];
  /** Runs with elevated rights (sudo, runas, Start-Process -Verb RunAs). */
  readonly elevated: boolean;
  /** The same strict classifier as Safe commands proves the command read-only / workspace-only; null otherwise. */
  readonly safeVerdict: SafeVerdict | null;
  /** The command was cut (16 KiB): the reading covers only the part shown. */
  readonly partial: boolean;
}

const MAX_HINT_ITEMS = 10;
const MAX_HINT_CHARS = 160;

class Bag {
  readonly items: string[] = [];
  add(v: string): void {
    const s = clip(oneLine(v), MAX_HINT_CHARS);
    if (s === '' || this.items.includes(s) || this.items.length >= MAX_HINT_ITEMS) return;
    this.items.push(s);
  }
}

interface Word {
  readonly text: string;
  readonly quoted: boolean;
}
type Tok =
  | { readonly k: 'word'; readonly w: Word }
  | { readonly k: 'sep' }
  | { readonly k: 'call' }
  | { readonly k: 'redir'; readonly append: boolean; readonly input: boolean };

/** Tolerant tokenizer for hints: words (quotes removed) and separators at any depth. */
function lex(command: string, shell: ApprovalShell, subs: string[] = []): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let quoted = false;
  let inWord = false;
  const esc = shell === 'powershell' ? '`' : shell === 'cmd' ? '^' : '\\';
  const flush = (): void => {
    if (inWord) toks.push({ k: 'word', w: { text: cur, quoted } });
    cur = '';
    quoted = false;
    inWord = false;
  };
  for (let i = 0; i < command.length && toks.length < 4000; i++) {
    const c = command[i] ?? '';
    if (c === ' ' || c === '\t') {
      flush();
      continue;
    }
    if (c === '#' && !inWord && shell !== 'cmd') {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length : nl - 1;
      continue;
    }
    if (c === "'" && shell !== 'cmd') {
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end === -1 ? command.length : end);
      quoted = true;
      inWord = true;
      i = end === -1 ? command.length : end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '$' && command[j + 1] === '(' && shell !== 'cmd') {
          // A subexpression inside a double-quoted string runs a command too: read it separately.
          let depth = 0;
          let k = j + 1;
          for (; k < command.length; k++) {
            if (command[k] === '(') depth++;
            else if (command[k] === ')' && --depth === 0) break;
          }
          subs.push(command.slice(j + 2, k));
          cur += command.slice(j, k + 1);
          j = k;
        } else if (command[j] === esc && shell !== 'cmd' && j + 1 < command.length) {
          j++;
          cur += command[j] ?? '';
        } else cur += command[j] ?? '';
      }
      quoted = true;
      inWord = true;
      i = j;
      continue;
    }
    if (c === esc && shell !== 'cmd') {
      cur += command[i + 1] ?? '';
      inWord = true;
      i++;
      continue;
    }
    if (c === '$' && command[i + 1] === '{') {
      const end = command.indexOf('}', i);
      cur += command.slice(i, end === -1 ? command.length : end + 1);
      inWord = true;
      i = end === -1 ? command.length : end;
      continue;
    }
    if (c === '>' || (c === '<' && shell !== 'powershell')) {
      if (inWord && /^[0-9*]$/.test(cur)) {
        cur = '';
        inWord = false;
      }
      flush();
      const append = command[i + 1] === '>';
      if (append) i++;
      if (command[i + 1] === '&' && /[0-9-]/.test(command[i + 2] ?? '')) {
        i += 2; // 2>&1: duplicate a descriptor, nothing written
        continue;
      }
      toks.push({ k: 'redir', append, input: c === '<' });
      continue;
    }
    if (c === '&' && command[i + 1] === '>' && shell === 'posix') {
      flush();
      i++;
      toks.push({ k: 'redir', append: false, input: false });
      continue;
    }
    if (c === '&' && shell === 'powershell' && command[i + 1] !== '&') {
      flush();
      toks.push({ k: 'call' });
      continue;
    }
    if (
      c === '.' &&
      shell === 'powershell' &&
      !inWord &&
      (command[i + 1] === ' ' || command[i + 1] === '\t')
    ) {
      toks.push({ k: 'call' }); // dot-sourcing runs the next word
      continue;
    }
    if (';|&\n(){}'.includes(c)) {
      flush();
      toks.push({ k: 'sep' });
      continue;
    }
    if ((c === '$' || c === '@') && command[i + 1] === '(') {
      flush();
      toks.push({ k: 'sep' });
      i++;
      continue;
    }
    cur += c;
    inWord = true;
  }
  flush();
  return toks;
}

interface Simple {
  readonly words: Word[];
  readonly redirs: { target: string; append: boolean; input: boolean }[];
  readonly call: boolean;
}

function simpleCommands(toks: readonly Tok[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirs: [], call: false };
  const end = (): void => {
    if (cur.words.length > 0 || cur.redirs.length > 0) out.push(cur);
    cur = { words: [], redirs: [], call: false };
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.k === 'sep') end();
    else if (t.k === 'call') {
      end();
      cur = { words: [], redirs: [], call: true };
    } else if (t.k === 'redir') {
      const next = toks[i + 1];
      if (next?.k === 'word') {
        cur.redirs.push({ target: next.w.text, append: t.append, input: t.input });
        i++;
      }
    } else cur.words.push(t.w);
  }
  end();
  return out;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'elseif',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'esac',
  'try',
  'catch',
  'finally',
  'return',
  'begin',
  'process',
  'end',
  'in',
  '!',
  '[',
  '[[',
  ']]',
  ']',
  'not',
  'exit',
  'break',
  'continue',
  'throw',
]);
/** A loop / declaration header: its words are not a command. */
const HEADERS = new Set([
  'for',
  'foreach',
  'case',
  'select',
  'function',
  'param',
  'switch',
  'filter',
  'trap',
]);
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'exec',
  'command',
  'nice',
  'timeout',
  'time',
  'stdbuf',
  'runas',
  'call',
  'start',
]);
const ELEVATE = new Set(['sudo', 'doas', 'runas', 'gsudo']);

const DELETE_CMDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
  'rimraf',
]);
const WRITE_ALL_ARGS = new Set(['touch', 'mkdir', 'md', 'tee']);
const WRITE_LAST_ARG = new Set([
  'cp',
  'mv',
  'copy',
  'move',
  'xcopy',
  'robocopy',
  'rsync',
  'scp',
  'ln',
  'install',
]);
const PS_WRITE: Readonly<Record<string, readonly string[]>> = {
  'new-item': ['path'],
  ni: ['path'],
  'set-content': ['path', 'literalpath'],
  'add-content': ['path', 'literalpath'],
  'out-file': ['filepath', 'literalpath'],
  'export-csv': ['path', 'literalpath'],
  'copy-item': ['destination'],
  cpi: ['destination'],
  'move-item': ['destination'],
  mi: ['destination'],
  'rename-item': ['path'],
  'expand-archive': ['destinationpath'],
  'compress-archive': ['destinationpath'],
  'invoke-webrequest': ['outfile'],
  iwr: ['outfile'],
  'invoke-restmethod': ['outfile'],
  'start-bitstransfer': ['destination'],
};
/** PowerShell parameters that take no value. */
const PS_SWITCHES = new Set([
  'force',
  'recurse',
  'append',
  'noclobber',
  'nonewline',
  'passthru',
  'whatif',
  'confirm',
  'noprofile',
  'noninteractive',
  'usebasicparsing',
  'wait',
  'nonewwindow',
  'raw',
  'asjob',
  'verbose',
  'debug',
  'resolve',
  'relative',
  'file',
  'directory',
  'hidden',
  'readonly',
  'system',
]);

interface PsArgs {
  readonly named: Map<string, string>;
  readonly positional: string[];
}

function psArgs(words: readonly Word[]): PsArgs {
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === undefined) continue;
    if (!w.quoted && /^-[A-Za-z]/.test(w.text)) {
      const [rawName, attached] = w.text.slice(1).split(':', 2);
      const name = (rawName ?? '').toLowerCase();
      if (attached !== undefined && attached !== '') named.set(name, attached);
      else if (PS_SWITCHES.has(name)) named.set(name, '');
      else {
        const v = words[i + 1];
        if (v !== undefined) {
          named.set(name, v.text);
          i++;
        }
      }
    } else positional.push(w.text);
  }
  return { named, positional };
}

function posixOperands(words: readonly Word[]): string[] {
  const out: string[] = [];
  let opts = true;
  for (const w of words) {
    if (opts && w.text === '--' && !w.quoted) {
      opts = false;
      continue;
    }
    if (opts && !w.quoted && w.text.startsWith('-') && w.text !== '-') continue;
    out.push(w.text);
  }
  return out;
}

const INSTALLERS: readonly { readonly exe: readonly string[]; readonly sub: readonly string[] }[] = [
  { exe: ['npm'], sub: ['install', 'i', 'ci', 'add', 'update', 'up'] },
  { exe: ['pnpm', 'yarn', 'bun'], sub: ['add', 'install', 'i', 'update', 'up', 'global'] },
  { exe: ['pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'mamba'], sub: ['install', 'add'] },
  {
    exe: ['cargo', 'go', 'gem', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper', 'snap'],
    sub: ['install', 'add', '-s', '-S'],
  },
  { exe: ['winget', 'choco', 'scoop', 'nuget', 'dotnet'], sub: ['install', 'add'] },
];

function isWinPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function looksAbsolute(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('~') ||
    isWinPath(p) ||
    /^\$env:[A-Za-z_]\w*[\\/]/i.test(p) ||
    /^\$\{?HOME\}?[\\/]/.test(p) ||
    /^%[A-Za-z_]\w*%[\\/]/.test(p)
  );
}

const DEVICE_TARGETS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '$null',
  'nul',
  'nul:',
  '/dev/tty',
]);

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Where `p` lies relative to the workspace: null when inside (or unknown and relative). */
function outsideOf(p: string, root: string | undefined): boolean {
  if (p === '' || DEVICE_TARGETS.has(p.toLowerCase()) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return true;
  if (!looksAbsolute(p)) return false;
  if (root === undefined || root === '') return true;
  const win = isWinPath(root);
  const a = win ? normPath(p).toLowerCase() : normPath(p);
  const r = win ? normPath(root).toLowerCase() : normPath(root);
  return !(a === r || a.startsWith(`${r}/`));
}

const URL_RE = /\b(?:https?|wss?|ftp|sftp|ssh|git):\/\/[^\s"'`<>(){}|;,]+/gi;
const SSH_HOST_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::[^\s]*)?$/;

function envVars(command: string, shell: ApprovalShell, bag: Bag): void {
  if (shell === 'powershell') {
    for (const m of command.matchAll(/\$env:([A-Za-z_][\w]*)|\$\{env:([^}]+)\}/gi))
      bag.add(m[1] ?? m[2] ?? '');
    for (const m of command.matchAll(
      /\[(?:System\.)?Environment\]::GetEnvironmentVariable\(\s*['"]([^'"]+)['"]/gi,
    ))
      bag.add(m[1] ?? '');
  } else if (shell === 'cmd') {
    for (const m of command.matchAll(/%([A-Za-z_][\w]*)%/g)) bag.add(m[1] ?? '');
  } else {
    // Upper-case names: the convention for environment variables (lower-case ones are usually script variables).
    for (const m of command.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\b/g)) bag.add(m[1] ?? '');
    for (const m of command.matchAll(/%([A-Za-z_][\w]*)%/g)) bag.add(m[1] ?? '');
  }
}

/**
 * The "what this touches" hints of a call (docs/design/p10-approval-readable.md §4): a static reading of the
 * command text and the named paths. Not a guarantee — the command can compute names at run time, call scripts, or
 * use programs this reading does not know; the console says so next to it.
 */
export function approvalHints(d: ApprovalDetails): ApprovalHints {
  const runs = new Bag();
  const reaches = new Bag();
  const writes = new Bag();
  const deletes = new Bag();
  const installs = new Bag();
  const env = new Bag();
  const outside = new Bag();
  let elevated = false;
  const root = d.workspaceRoot ?? (d.cwd !== undefined && looksAbsolute(d.cwd) ? d.cwd : undefined);
  const consider = (p: string): void => {
    if (outsideOf(p, root)) outside.add(p);
  };

  if (d.url !== undefined) reaches.add(d.url);
  for (const p of d.paths ?? []) consider(p);
  if (d.cwd !== undefined && d.workspaceRoot !== undefined) consider(d.cwd);

  let safeVerdict: SafeVerdict | null = null;
  const command = d.command;
  if (command !== undefined) {
    const shell = d.shell ?? guessShell(d.tool, command);
    for (const m of command.matchAll(URL_RE)) reaches.add(m[0].replace(/[.,:;!?]+$/, ''));
    envVars(command, shell, env);
    const vars = new Map<string, string>();
    const subs: string[] = [];
    const commands = simpleCommands(lex(command, shell, subs));
    for (let q = 0; q < subs.length && q < 32; q++)
      commands.push(...simpleCommands(lex(subs[q] ?? '', shell, subs)));
    for (const sc of commands) {
      for (const r of sc.redirs) {
        if (r.input) consider(r.target);
        else if (!DEVICE_TARGETS.has(r.target.toLowerCase())) {
          writes.add(r.target);
          consider(r.target);
        }
      }
      let words = sc.words;
      let i = 0;
      // Assignments: `NAME=value cmd` (POSIX), `$name = "value"` (PowerShell), `set NAME=value` (cmd).
      while (i < words.length) {
        const w = words[i];
        if (w === undefined) break;
        const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(w.text);
        if (m !== null && !w.quoted && shell !== 'powershell') {
          vars.set(m[1] ?? '', m[2] ?? '');
          i++;
          continue;
        }
        break;
      }
      words = words.slice(i);
      const first = words[0];
      if (first === undefined) continue;
      if (shell === 'powershell' && /^\$[\w:]+$/.test(first.text) && !first.quoted) {
        const op = words[1]?.text;
        if (op === '=' || op === '+=' || op === '??=') {
          const value = words[2];
          if (words.length === 3 && value !== undefined)
            vars.set(first.text.slice(1).toLowerCase(), value.text);
          continue;
        }
        if (!sc.call) continue; // a bare variable is an expression, not a program
      }
      let j = 0;
      while (j < words.length) {
        const w = words[j];
        if (w === undefined) break;
        const t = w.text.toLowerCase();
        if (!w.quoted && KEYWORDS.has(t)) {
          j++;
          continue;
        }
        break;
      }
      const head = words[j];
      if (head === undefined) continue;
      if (!head.quoted && HEADERS.has(head.text.toLowerCase())) continue;
      if (!head.quoted && /^-[A-Za-z]/.test(head.text) && shell === 'powershell') continue; // -not, -and …
      if (!sc.call && /^[\d.]+$/.test(head.text)) continue;
      if (/^\[.*\]/.test(head.text) && shell === 'powershell') continue; // [Type]::Method(…)
      let rest = words.slice(j);
      // Wrappers: record the elevating ones, then read the program they run.
      for (;;) {
        const w = rest[0];
        if (w === undefined) break;
        const name = baseName(w.text)
          .toLowerCase()
          .replace(/\.exe$/, '');
        if (!WRAPPERS.has(name) || w.quoted) break;
        if (ELEVATE.has(name)) {
          elevated = true;
          runs.add(name);
        }
        let k = 1;
        while (k < rest.length) {
          const x = rest[k];
          if (x === undefined) break;
          const flag =
            (!x.quoted && x.text.startsWith('-')) ||
            ((name === 'runas' || name === 'start') &&
              (x.text.startsWith('/') || (x.quoted && x.text === ''))) ||
            ((name === 'timeout' || name === 'nice') && /^-?\d+[smhd]?$/.test(x.text)) ||
            (name === 'env' && /^[A-Za-z_]\w*=/.test(x.text));
          if (!flag) break;
          k++;
        }
        rest = rest.slice(k);
      }
      const exeWord = rest[0];
      if (exeWord === undefined) continue;
      let exeText = exeWord.text;
      if (exeText.startsWith('$')) {
        const resolved =
          vars.get(exeText.replace(/^\$\{?|\}$/g, '').toLowerCase()) ??
          vars.get(exeText.replace(/^\$\{?|\}$/g, ''));
        exeText = resolved ?? exeText;
      }
      const exe = baseName(exeText);
      const name = exe.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
      if (exe === '') continue;
      runs.add(exe);
      if (looksAbsolute(exeText)) consider(exeText);
      const args = rest.slice(1);
      for (const a of args) {
        if (SSH_HOST_RE.test(a.text) && ['ssh', 'scp', 'rsync', 'sftp', 'git'].includes(name))
          reaches.add(a.text.split(':')[0] ?? a.text);
        if (looksAbsolute(a.text) || /(^|[\\/])\.\.([\\/]|$)/.test(a.text))
          consider(a.text.replace(/^-[\w-]+[=:]/, ''));
        const eq = /^--?[\w-]+=(.+)$/.exec(a.text);
        if (eq?.[1] !== undefined && looksAbsolute(eq[1])) consider(eq[1]);
      }
      if (name === 'start-process' || name === 'saps') {
        const pa = psArgs(args);
        if ((pa.named.get('verb') ?? '').toLowerCase() === 'runas') elevated = true;
        const target = pa.named.get('filepath') ?? pa.positional[0];
        if (target !== undefined) runs.add(baseName(target));
      }
      // Deletes.
      if (DELETE_CMDS.has(name)) {
        const targets =
          shell === 'powershell' || name === 'remove-item' || name === 'ri'
            ? (() => {
                const pa = psArgs(args);
                const named = pa.named.get('path') ?? pa.named.get('literalpath');
                return named !== undefined ? [named, ...pa.positional] : pa.positional;
              })()
            : posixOperands(args).filter((a) => !/^\/[a-z]$/i.test(a));
        for (const t of targets) {
          deletes.add(t);
          consider(t);
        }
        if (targets.length === 0) deletes.add(exe);
      }
      if (name === 'git') {
        const sub = posixOperands(args)[0];
        if (sub === 'clean') deletes.add('git clean (untracked files)');
        if (sub === 'reset' && args.some((a) => a.text === '--hard'))
          deletes.add('git reset --hard (uncommitted changes)');
        if (sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone') {
          if (!args.some((a) => /:\/\//.test(a.text) || SSH_HOST_RE.test(a.text)))
            reaches.add(`git ${sub} (remote)`);
        }
        if (
          sub === 'push' &&
          args.some((a) => a.text === '--force' || a.text === '-f' || a.text.startsWith('--force-with-lease'))
        )
          writes.add('git push --force (remote history)');
      }
      // Writes.
      if (WRITE_ALL_ARGS.has(name)) {
        for (const t of posixOperands(args)) {
          writes.add(t);
          consider(t);
        }
      } else if (WRITE_LAST_ARG.has(name)) {
        const ops = posixOperands(args).filter((a) => !/^\/[a-z]+$/i.test(a));
        const last = ops[ops.length - 1];
        if (ops.length >= 2 && last !== undefined) {
          writes.add(last);
          consider(last);
        }
      } else if (PS_WRITE[name] !== undefined) {
        const pa = psArgs(args);
        let target: string | undefined;
        for (const p of PS_WRITE[name]) target ??= pa.named.get(p);
        if (target === undefined) {
          const pos = name === 'copy-item' || name === 'cpi' || name === 'move-item' || name === 'mi' ? 1 : 0;
          if (name !== 'invoke-webrequest' && name !== 'iwr' && name !== 'invoke-restmethod')
            target = pa.positional[pos];
        }
        if (target !== undefined) {
          writes.add(target);
          consider(target);
        }
      } else if (name === 'curl' || name === 'wget') {
        for (let k = 0; k < args.length; k++) {
          const a = args[k]?.text ?? '';
          const m = /^(?:--output|--output-document|--directory-prefix)=(.+)$/.exec(a);
          const target =
            m?.[1] ??
            (a === '-o' || a === '-O' || a === '--output' || a === '-P' ? args[k + 1]?.text : undefined);
          if (target !== undefined && !(name === 'curl' && a === '-O')) {
            writes.add(target);
            consider(target);
          }
        }
      }
      // Installs.
      const lowerArgs = args.map((a) => a.text.toLowerCase());
      const subIdx = lowerArgs.findIndex((a) => !a.startsWith('-'));
      const sub = subIdx === -1 ? undefined : lowerArgs[subIdx];
      for (const inst of INSTALLERS) {
        if (!inst.exe.includes(name)) continue;
        const pip = name === 'uv' && sub === 'pip' ? lowerArgs[subIdx + 1] : sub;
        if (
          (pip !== undefined && inst.sub.includes(pip)) ||
          (name === 'pacman' && lowerArgs.some((a) => /^-S/.test(a)))
        )
          installs.add([exe, ...args.map((a) => a.text)].join(' '));
      }
      if (
        (name === 'python' || name === 'python3' || name === 'py') &&
        lowerArgs[0] === '-m' &&
        lowerArgs[1] === 'pip' &&
        lowerArgs[2] === 'install'
      )
        installs.add([exe, ...args.map((a) => a.text)].join(' '));
      if (name === 'npx' || name === 'pnpx' || name === 'bunx' || name === 'uvx') {
        const pkg = args.find((a) => !a.text.startsWith('-'));
        if (pkg !== undefined) installs.add(`${exe} ${pkg.text} (downloads and runs a package)`);
      }
      if (name === 'install-module' || name === 'install-package' || name === 'install-script') {
        const pa = psArgs(args);
        installs.add(`${exe} ${pa.named.get('name') ?? pa.positional[0] ?? ''}`.trim());
      }
    }
    if (d.commandTruncated !== true && command.length <= MAX_SAFE_COMMAND_LENGTH && root !== undefined) {
      try {
        const c = classifyCommand({
          command,
          shells: [shell],
          platform: isWinPath(root) ? 'win32' : 'posix',
          workspaceRoot: root,
        });
        if (c.safe) safeVerdict = c.verdict;
      } catch {
        safeVerdict = null; // a reading, never a decision
      }
    }
  }
  return {
    runs: runs.items,
    reaches: reaches.items,
    writes: writes.items,
    deletes: deletes.items,
    installs: installs.items,
    envVars: env.items,
    outside: outside.items,
    elevated,
    safeVerdict,
    partial: d.commandTruncated === true,
  };
}
