import { checkGit } from './git.js';
import { isNullDevice } from './paths.js';
import { CMD_RULES, type CmdRule } from './rules.js';
import { type Arg, type Effects, notSafe } from './types.js';

/**
 * cmd.exe: commands separated by `&`, `&&`, `||`, `|` and newlines, double-quoted arguments and simple
 * redirections. Refused anywhere: `%` and `!` (variable expansion happens even inside quotes), `^` escapes,
 * parentheses (blocks), `@`, and outside quotes `,` `;` `=` (cmd also splits arguments on them) and non-ASCII.
 * The command name must be a plain word (`dir/s`, `echo.` and `cd..` are refused).
 */

interface Command {
  readonly words: readonly string[];
  readonly redirects: readonly { readonly kind: 'read' | 'write' | 'dup'; readonly target: string | null }[];
}

const RULES = new Map<string, CmdRule>();
for (const r of CMD_RULES) for (const n of r.names) RULES.set(n, r);

const ANYWHERE_REFUSED = /[%!^]/;
const UNQUOTED_REFUSED = new Set(['(', ')', '@', ',', ';', '=', '`']);
const WORD_END = new Set([' ', '\t', '\n', '&', '|', '<', '>']);

function parse(src: string): Command[] {
  if (ANYWHERE_REFUSED.test(src)) notSafe('cmd_expansion_or_escape');
  const commands: Command[] = [];
  let pos = 0;
  let afterOperator = false;
  let words: string[] = [];
  let redirects: Command['redirects'][number][] = [];
  const peek = (n = 0): string => src.charAt(pos + n);
  const finish = (): void => {
    if (words.length === 0) {
      if (redirects.length > 0) notSafe('empty_command');
      return;
    }
    commands.push({ words, redirects });
    words = [];
    redirects = [];
    afterOperator = false;
  };
  const word = (): string => {
    let text = '';
    const start = pos;
    for (;;) {
      const c = peek();
      if (c === '' || WORD_END.has(c)) break;
      if (c === '"') {
        const close = src.indexOf('"', pos + 1);
        if (close === -1) notSafe('unterminated_quote');
        const inner = src.slice(pos + 1, close);
        if (inner.includes('\n')) notSafe('parse_error');
        text += inner;
        pos = close + 1;
        continue;
      }
      if (UNQUOTED_REFUSED.has(c)) notSafe(`unquoted_${c}`);
      if (c.charCodeAt(0) > 0x7e) notSafe('non_ascii');
      text += c;
      pos++;
    }
    if (pos === start) notSafe('parse_error');
    return text;
  };
  for (;;) {
    const c = peek();
    if (c === ' ' || c === '\t') {
      pos++;
      continue;
    }
    if (c === '' || c === '\n') {
      finish();
      if (afterOperator) notSafe('parse_error');
      if (c === '') break;
      pos++;
      continue;
    }
    if (c === '&' || c === '|') {
      if (words.length === 0) notSafe('parse_error');
      finish();
      const two = src.slice(pos, pos + 2);
      pos += two === '&&' || two === '||' ? 2 : 1;
      afterOperator = true;
      continue;
    }
    const m = /^(\d?)(>>|>|<)(&\d)?/.exec(src.slice(pos));
    if (m) {
      pos += m[0].length;
      if (m[3] !== undefined) {
        redirects.push({ kind: 'dup', target: null });
        continue;
      }
      while (peek() === ' ' || peek() === '\t') pos++;
      redirects.push({ kind: m[2] === '<' ? 'read' : 'write', target: word() });
      continue;
    }
    words.push(word());
  }
  return commands;
}

function checkCommand(rule: CmdRule, args: readonly string[], fx: Effects): void {
  fx.rules.add(rule.id);
  if (rule.exactArgs !== undefined) {
    const got = args.map((a) => a.toLowerCase());
    if (got.length !== rule.exactArgs.length || got.some((a, i) => a !== rule.exactArgs?.[i])) {
      notSafe('arguments_not_allowed');
    }
    return;
  }
  if (rule.positional === 'data') return; // echo: everything up to the next operator is text
  const operands: string[] = [];
  let patternGiven = false;
  for (const a of args) {
    if (a.startsWith('/')) {
      const m = /^\/([A-Za-z0-9-]+)(?::(.*))?$/.exec(a);
      if (!m) notSafe('cmd_switch');
      const name = (m[1] ?? '').toLowerCase();
      const value = m[2];
      // dir's attribute / order / time switches: /a:h, /ad, /o-d, /o:-n, /tw
      if (rule.id === 'cmd.dir' && 'aot'.includes(name.charAt(0))) {
        const tail = name.slice(1) + (value ?? '');
        if (/^[A-Za-z-]*$/.test(tail) && (value === undefined || name.length === 1)) continue;
      }
      const role = rule.switches[name];
      if (role === undefined) notSafe('cmd_switch');
      if (role === 'flag') {
        if (value !== undefined) notSafe('cmd_switch');
        continue;
      }
      if (value === undefined || value === '') notSafe('missing_option_value');
      if (role === 'pattern') patternGiven = true;
      fx.apply(role, { text: value, dynamic: false });
      continue;
    }
    operands.push(a);
  }
  if (rule.positional === 'none' && operands.length > 0) notSafe('operands_not_allowed');
  for (const [i, a] of operands.entries()) {
    if (rule.positional === 'paths') fx.read(a);
    else if (rule.positional === 'wpaths') fx.write(a);
    else if (rule.positional === 'pattern-then-paths') {
      if (i === 0 && !patternGiven) continue;
      fx.read(a);
    }
  }
}

export function classifyCmd(command: string, fx: Effects): void {
  for (const cmd of parse(command)) {
    for (const r of cmd.redirects) {
      if (r.kind === 'dup') {
        fx.rules.add('redirect.null');
        continue;
      }
      const target = r.target ?? notSafe('parse_error');
      if (r.kind === 'write' && isNullDevice(target, 'cmd')) {
        fx.rules.add('redirect.null');
        continue;
      }
      if (r.kind === 'read') {
        fx.rules.add('redirect.read');
        fx.read(target);
      } else {
        fx.rules.add('redirect.write');
        fx.write(target);
      }
    }
    const [head, ...args] = cmd.words;
    if (head === undefined || !/^[A-Za-z]+$/.test(head)) notSafe('command_name');
    const name = head.toLowerCase();
    if (name === 'git') {
      checkGit(
        args.map((t): Arg => ({ text: t, dynamic: false })),
        fx,
      );
      continue;
    }
    const rule = RULES.get(name);
    if (rule === undefined) notSafe(`unknown_command:${name.slice(0, 40)}`);
    checkCommand(rule, args, fx);
  }
}
