import { checkGit } from './git.js';
import { isNullDevice } from './paths.js';
import { POSIX_RULES, type PosixRule } from './rules.js';
import { type Arg, type ArgRole, type Effects, looksLikePath, notSafe } from './types.js';

/**
 * bash / sh / zsh (and Git Bash on Windows): a small recursive-descent parser for the strict subset the classifier
 * accepts. Lists (`;`, newline, `&&`, `||`), pipelines (`|`), subshells `( … )`, command substitution `$( … )` and
 * backticks, single and double quotes and simple redirections are understood; everything else — variables, globs,
 * brace / tilde / history expansion, here-documents, process substitution, background `&`, `[[ ]]`, functions,
 * assignments, comments, escapes, zsh's `=cmd` and `^` — is refused. Words containing a substitution are only
 * accepted where the command treats them as text.
 */

interface Word {
  readonly text: string;
  readonly dynamic: boolean;
  /** Inner command lists of `$( … )` / backticks; classified as part of the line. */
  readonly subs: readonly Script[];
}

interface Redirect {
  readonly kind: 'read' | 'write' | 'dup';
  readonly target: Word | null;
}

type Node =
  | { readonly kind: 'cmd'; readonly words: readonly Word[]; readonly redirects: readonly Redirect[] }
  | { readonly kind: 'group'; readonly body: Script; readonly redirects: readonly Redirect[] };

type Script = readonly Node[];

const RULES = new Map<string, PosixRule>();
for (const r of POSIX_RULES) for (const n of r.names) RULES.set(n, r);

/** Unquoted characters with a meaning we do not model. */
const UNQUOTED_REFUSED = new Set([
  '*',
  '?',
  '[',
  ']',
  '{',
  '}',
  '~',
  '!',
  '#',
  '\\',
  '^',
  '$',
  '`',
  '"',
  "'",
]);
const OPERATOR_CHARS = new Set([';', '&', '|', '(', ')', '<', '>', '\n']);

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Script {
    const script = this.script(null);
    if (this.pos !== this.src.length) notSafe('parse_error');
    return script;
  }

  private peek(n = 0): string {
    return this.src.charAt(this.pos + n);
  }

  private skipBlanks(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  /** Command list up to `end` (`)` for a subshell / substitution) or the end of input. */
  private script(end: ')' | null): Script {
    const nodes: Node[] = [];
    let expectCommand = true;
    /** After `&&`, `||` or `|` a command must follow. */
    let afterOperator = false;
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === '' || c === ')') {
        if (c === '' && end !== null) notSafe('unterminated_group');
        if (c === ')' && end !== ')') notSafe('parse_error');
        if (afterOperator) notSafe('parse_error');
        break;
      }
      if (c === ';' || c === '\n') {
        if (afterOperator || (c === ';' && (expectCommand || this.peek(1) === ';'))) notSafe('parse_error');
        this.pos++;
        expectCommand = true;
        continue;
      }
      if (c === '&' || c === '|') {
        const two = this.src.slice(this.pos, this.pos + 2);
        if (two === '&&' || two === '||') this.pos += 2;
        else if (c === '|' && this.peek(1) !== '&') this.pos += 1;
        else notSafe(c === '&' ? 'background_job' : 'parse_error');
        if (expectCommand) notSafe('parse_error');
        expectCommand = true;
        afterOperator = true;
        continue;
      }
      if (!expectCommand) notSafe('parse_error');
      if (c === '(') {
        this.pos++;
        if (this.peek() === '(') notSafe('arithmetic');
        const body = this.script(')');
        this.pos++; // ')'
        nodes.push({ kind: 'group', body, redirects: this.redirectsOnly() });
      } else {
        nodes.push(this.simple());
      }
      expectCommand = false;
      afterOperator = false;
    }
    return nodes;
  }

  private redirectsOnly(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      this.skipBlanks();
      const r = this.redirect();
      if (r === null) break;
      out.push(r);
    }
    const c = this.peek();
    if (c !== '' && !OPERATOR_CHARS.has(c)) notSafe('parse_error');
    return out;
  }

  private simple(): Node {
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === '' || c === ';' || c === '\n' || c === '|' || c === ')') break;
      if (c === '&') {
        if (this.peek(1) === '>') {
          const r = this.redirect();
          if (r !== null) redirects.push(r);
          continue;
        }
        break; // `&&` (or `&`, refused by the caller)
      }
      if (c === '(') notSafe('parse_error');
      const r = this.redirect();
      if (r !== null) {
        redirects.push(r);
        continue;
      }
      words.push(this.word());
    }
    if (words.length === 0) notSafe('empty_command');
    return { kind: 'cmd', words, redirects };
  }

  /** A redirection at the cursor, or null. */
  private redirect(): Redirect | null {
    const rest = this.src.slice(this.pos);
    const m = /^(\d?)(&>>|&>|>>|>\||>&|<&|<<|<>|>|<)/.exec(rest);
    if (!m) return null;
    const op = m[2] ?? '';
    this.pos += m[0].length;
    if (op === '<<' || op === '<&' || op === '<>') notSafe('unsupported_redirection');
    if (this.peek() === '(') notSafe('process_substitution');
    if (op === '>&') {
      const fd = /^(\d|-)/.exec(this.src.slice(this.pos));
      if (fd) {
        this.pos += 1;
        return { kind: 'dup', target: null };
      }
    }
    this.skipBlanks();
    const target = this.word();
    if (target.dynamic) notSafe('dynamic_redirect');
    return { kind: op === '<' ? 'read' : 'write', target };
  }

  private word(): Word {
    let text = '';
    let dynamic = false;
    const subs: Script[] = [];
    const start = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === '' || c === ' ' || c === '\t' || OPERATOR_CHARS.has(c)) break;
      if (c === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) notSafe('unterminated_quote');
        text += this.src.slice(this.pos + 1, close);
        this.pos = close + 1;
        continue;
      }
      if (c === '"') {
        this.pos++;
        for (;;) {
          const d = this.peek();
          if (d === '') notSafe('unterminated_quote');
          if (d === '"') {
            this.pos++;
            break;
          }
          if (d === '$' && this.peek(1) === '(') {
            subs.push(this.substitution());
            dynamic = true;
            continue;
          }
          if (d === '`') {
            subs.push(this.backtick());
            dynamic = true;
            continue;
          }
          if (d === '$' || d === '\\' || d === '!') notSafe('expansion_in_quotes');
          text += d;
          this.pos++;
        }
        continue;
      }
      if (c === '$' && this.peek(1) === '(') {
        subs.push(this.substitution());
        dynamic = true;
        continue;
      }
      if (c === '`') {
        subs.push(this.backtick());
        dynamic = true;
        continue;
      }
      // `HEAD~1` is literal; a tilde at the start of a word or after `=` / `:` is the home directory.
      if (c === '~' && this.pos !== start && !/[=:]$/.test(text)) {
        text += c;
        this.pos++;
        continue;
      }
      if (UNQUOTED_REFUSED.has(c)) notSafe(`unquoted_${c === '\\' ? 'backslash' : c}`);
      if (c.charCodeAt(0) > 0x7e) notSafe('non_ascii');
      if (c === '=' && this.pos === start) notSafe('zsh_equals_expansion');
      text += c;
      this.pos++;
    }
    if (this.pos === start) notSafe('parse_error');
    return { text, dynamic, subs };
  }

  private substitution(): Script {
    this.pos += 2; // `$(`
    if (this.peek() === '(') notSafe('arithmetic');
    const inner = this.script(')');
    this.pos++;
    return inner;
  }

  private backtick(): Script {
    const close = this.src.indexOf('`', this.pos + 1);
    if (close === -1) notSafe('unterminated_backtick');
    const body = this.src.slice(this.pos + 1, close);
    if (body.includes('\\')) notSafe('backtick_escape');
    this.pos = close + 1;
    return new Parser(body).parse();
  }
}

function matchLong(table: Readonly<Record<string, ArgRole>> | undefined, name: string): ArgRole | null {
  if (table === undefined) return null;
  const exact = table[name];
  if (exact !== undefined) return exact;
  // GNU getopt accepts unambiguous prefixes: `--fi` is `--file`. Any role a prefix could mean counts (path wins).
  const roles = Object.entries(table)
    .filter(([k]) => name.length >= 3 && k.startsWith(name))
    .map(([, v]) => v);
  if (roles.length === 0) return null;
  return roles.includes('path') ? 'path' : (roles[0] ?? null);
}

function forbidden(rule: PosixRule, name: string): boolean {
  return (rule.forbidden ?? []).some((f) =>
    f.startsWith('--') ? name.startsWith('--') && name.length >= 3 && f.startsWith(name) : f === name,
  );
}

function checkFind(rule: PosixRule, args: readonly Arg[], fx: Effects): void {
  let i = 0;
  // Leading -P / -O<n> options, then the start paths, then the expression.
  while (i < args.length && /^-(P|O\d)$/.test(args[i]?.text ?? '')) i++;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a.dynamic) notSafe('dynamic_argument');
    if (a.text.startsWith('-') || a.text === '(' || a.text === '!' || a.text === ')') break;
    fx.read(a.text);
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a.dynamic) notSafe('dynamic_argument');
    if (forbidden(rule, a.text) || (rule.forbidden ?? []).some((f) => a.text.startsWith(f) && f.length > 2)) {
      notSafe('forbidden_option');
    }
  }
}

function checkCommand(rule: PosixRule, args: readonly Arg[], fx: Effects): void {
  fx.rules.add(rule.id);
  if (rule.noArgs === true) {
    if (args.length > 0) notSafe('arguments_not_allowed');
    return;
  }
  if (rule.id === 'posix.find') {
    checkFind(rule, args, fx);
    return;
  }
  // A substitution's output is re-split and re-parsed as options by the program (`rg $(echo --pre=x)`): only
  // commands that never parse options (echo) may take one.
  if (rule.noOptions !== true && args.some((a) => a.dynamic)) notSafe('dynamic_argument');
  const operands: Arg[] = [];
  const seen = { pattern: false };
  let endOfOptions = rule.noOptions === true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    const t = a.text;
    if (!endOfOptions && t.startsWith('-') && t !== '-') {
      if (a.dynamic) notSafe('dynamic_option');
      if (t === '--') {
        endOfOptions = true;
        continue;
      }
      const value = (role: ArgRole, attached: string | null): void => {
        let v: Arg;
        if (attached !== null) v = { text: attached, dynamic: false };
        else {
          const next = args[i + 1];
          if (next === undefined) notSafe('missing_option_value');
          v = next;
          i++;
          // A long option may take its value only when attached (`--color[=WHEN]`): the next word may be an
          // operand after all, so it is checked as a path as well.
          if (t.startsWith('--') && role !== 'path' && role !== 'wpath') fx.read(next.text);
        }
        if (role === 'pattern') seen.pattern = true;
        fx.apply(role, v);
      };
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        const name = eq === -1 ? t : t.slice(0, eq);
        const attached = eq === -1 ? null : t.slice(eq + 1);
        if (forbidden(rule, name)) notSafe('forbidden_option');
        const role = matchLong(rule.longValue, name);
        if (role !== null) value(role, attached);
        else if (attached !== null) fx.apply(looksLikePath(attached) ? 'path' : 'data', a);
        continue;
      }
      for (let j = 1; j < t.length; j++) {
        const ch = t.charAt(j);
        if (forbidden(rule, `-${ch}`)) notSafe('forbidden_option');
        const role = rule.shortValue?.[ch];
        if (role !== undefined) {
          const rest = t.slice(j + 1);
          value(role, rest.length > 0 ? rest : null);
          break;
        }
      }
      continue;
    }
    operands.push(a);
  }
  if (rule.maxPositional !== undefined && operands.length > rule.maxPositional) notSafe('too_many_operands');
  if (rule.positional === 'none' && operands.length > 0) notSafe('operands_not_allowed');
  for (const [idx, a] of operands.entries()) {
    if (rule.operandPrefix !== undefined && !a.text.startsWith(rule.operandPrefix))
      notSafe('operand_not_allowed');
    switch (rule.positional) {
      case 'data':
      case 'none':
        break;
      case 'paths':
        fx.apply('path', a);
        break;
      case 'wpaths':
        fx.apply('wpath', a);
        break;
      case 'pattern-then-paths':
        fx.apply(idx === 0 && !seen.pattern ? 'pattern' : 'path', a);
        break;
    }
  }
}

function classifyScript(script: Script, fx: Effects, platform: 'posix' | 'win32'): void {
  for (const node of script) {
    for (const r of node.redirects) classifyRedirect(r, fx);
    if (node.kind === 'group') {
      classifyScript(node.body, fx, platform);
      continue;
    }
    for (const w of node.words) for (const s of w.subs) classifyScript(s, fx, platform);
    const [head, ...rest] = node.words;
    if (head === undefined) notSafe('empty_command');
    if (head.dynamic || !/^[A-Za-z0-9._+-]+$/.test(head.text)) notSafe('command_name');
    // Git Bash resolves programs case-insensitively (git.EXE); POSIX does not.
    const name = platform === 'win32' ? head.text.toLowerCase() : head.text;
    const args = rest.map((w) => ({ text: w.text, dynamic: w.dynamic }));
    if (name === 'git') {
      checkGit(args, fx);
      continue;
    }
    const rule = RULES.get(name);
    if (rule === undefined) notSafe(`unknown_command:${name.slice(0, 40)}`);
    checkCommand(rule, args, fx);
  }
}

function classifyRedirect(r: Redirect, fx: Effects): void {
  if (r.kind === 'dup') {
    fx.rules.add('redirect.null');
    return;
  }
  const target = r.target;
  if (target === null) notSafe('parse_error');
  if (r.kind === 'write' && isNullDevice(target.text, 'posix')) {
    fx.rules.add('redirect.null');
    return;
  }
  if (r.kind === 'read') {
    fx.rules.add('redirect.read');
    fx.read(target.text);
  } else {
    fx.rules.add('redirect.write');
    fx.write(target.text);
  }
}

export function classifyPosix(command: string, fx: Effects, platform: 'posix' | 'win32'): void {
  classifyScript(new Parser(command).parse(), fx, platform);
}
