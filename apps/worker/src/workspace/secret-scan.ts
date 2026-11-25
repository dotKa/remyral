import { DEFAULT_RULES, Redactor, SecretSet, type RedactionRule } from '@remyral/observability';
import type { SecretFinding } from './errors.js';

/**
 * Rules used by the pre-push scan (T-SEC-3). Only the self-identifying formats
 * (vendor prefixes, PEM blocks, JWTs): the context rules of the log redactor
 * (`password = …`, `Authorization: …`) are tuned for logs and would refuse
 * ordinary source code such as `password = readPassword()`.
 */
export const PRE_PUSH_RULE_IDS: ReadonlySet<string> = new Set([
  'pem-private-key',
  'anthropic-key',
  'openai-key',
  'github-token',
  'github-pat',
  'gitlab-token',
  'aws-access-key-id',
  'google-api-key',
  'slack-token',
  'stripe-key',
  'huggingface-token',
  'npm-token',
  'jwt',
]);

export function prePushRules(): RedactionRule[] {
  return DEFAULT_RULES.filter((r) => PRE_PUSH_RULE_IDS.has(r.id));
}

/** Scanner over the pre-push rules plus the exact values in `secrets` (the job's injected set). */
export function prePushScanner(secrets: SecretSet = new SecretSet()): Redactor {
  return new Redactor({ secrets, rules: prePushRules() });
}

export const COMMIT_MARKER = '\u0000remyral-commit ';
export const MESSAGE_END = '\u0000remyral-end-message';

/**
 * `git log` arguments producing the format `scanGitLog` parses: the commits of `branchRef` that are not upstream.
 *
 * p22-git-preflight: `exclude` (the workspace's base commit) bounds the walk to the attempt's own commits. Before, only
 * `--remotes=origin` bounded it, so a base the mirror no longer had under `refs/remotes/origin` (a squash-merged or
 * deleted branch, a pruned attempt branch, a SHA base) walked the repository's whole history with `-p` and the scan
 * died on its time or output limit ("git log failed (killed): timed out or output limit exceeded"). The base commit is
 * the master's choice (a fetched branch tip or a verified, already scanned result), never content of this attempt.
 */
export function scanLogArgs(branchRef: string, exclude?: string): string[] {
  if (exclude !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(exclude)) {
    throw new TypeError('scan exclusion must be a full commit sha');
  }
  return [
    'log',
    '-p',
    // p19-large-commit: no `--text` — a binary file (image, archive, font) is one "Binary files … differ" line instead of
    // its bytes as diff lines (hundreds of images made the scan exceed its time and output limits). The rules match
    // text formats (keys, tokens, PEM blocks, JWTs), which git diffs as text.
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-abbrev',
    `--format=%x00remyral-commit %H%n%B%n%x00remyral-end-message`,
    branchRef,
    '--not',
    ...(exclude === undefined ? [] : [exclude]),
    '--remotes=origin',
    '--',
  ];
}

/**
 * Scans the output of `git log -p` (see `scanLogArgs`): every commit message
 * and every added line. Removed and context lines are not scanned (they are
 * already upstream). Returns locations and rule ids only, never the values.
 * A PEM `BEGIN … PRIVATE KEY` line alone is a finding (block rule fails closed).
 * The NUL-delimited markers cannot be forged: git commit messages cannot contain NUL.
 */
export function scanGitLog(log: string, scanner: Redactor): SecretFinding[] {
  const scan = new GitLogScan(scanner);
  scan.write(log);
  return scan.end();
}

/** Findings kept by a streamed scan: beyond this the push is refused anyway, the rest adds nothing. */
const MAX_FINDINGS = 1000;

/**
 * p22-git-preflight: {@link scanGitLog} over a stream (`git log -p` output in chunks, `GitCall.onStdout`) — the scan
 * holds one line at a time instead of the whole log, so a large attempt is no longer refused by the output limit.
 */
export class GitLogScan {
  readonly #scanner: Redactor;
  readonly #decoder = new TextDecoder('utf-8');
  readonly #findings: SecretFinding[] = [];
  #rest = '';
  #commit = '';
  #inMessage = false;
  #file = '';
  #inHunk = false;
  #lineNo = 0;

  constructor(scanner: Redactor) {
    this.#scanner = scanner;
  }

  /** One chunk of the log (bytes are decoded as a UTF-8 stream; a split character is kept for the next chunk). */
  write(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const lines = (this.#rest + text).split('\n');
    this.#rest = lines.pop() ?? '';
    for (const line of lines) this.#line(line);
  }

  /** The findings (deduplicated); the last unterminated line is scanned too. */
  end(): SecretFinding[] {
    const tail = this.#rest + this.#decoder.decode();
    this.#rest = '';
    this.#line(tail);
    return dedupe(this.#findings);
  }

  #check(text: string, location: string): void {
    if (this.#findings.length >= MAX_FINDINGS) return;
    for (const span of this.#scanner.spans(text))
      this.#findings.push({ commit: this.#commit, location, label: span.label });
  }

  #line(line: string): void {
    if (line.startsWith(COMMIT_MARKER)) {
      this.#commit = line.slice(COMMIT_MARKER.length).trim();
      this.#inMessage = true;
      this.#inHunk = false;
      this.#file = '';
      return;
    }
    if (this.#inMessage) {
      if (line === MESSAGE_END) this.#inMessage = false;
      else this.#check(line, 'message');
      return;
    }
    if (line.startsWith('diff --git ')) {
      this.#inHunk = false;
      this.#file = '';
      return;
    }
    if (!this.#inHunk) {
      if (line.startsWith('+++ ')) this.#file = line.slice(4).replace(/^b\//, '');
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk !== null) {
        this.#inHunk = true;
        this.#lineNo = Number(hunk[1]);
      }
      return;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      this.#lineNo = Number(hunk[1]);
      return;
    }
    if (line.startsWith('+')) {
      this.#check(line.slice(1), `${this.#file}:${String(this.#lineNo)}`);
      this.#lineNo++;
    } else if (line.startsWith(' ')) {
      this.#lineNo++;
    }
  }
}

function dedupe(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.commit}\u0000${f.location}\u0000${f.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
