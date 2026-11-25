import { checkGit } from './git.js';
import { PS_RULES, type PsRule } from './rules.js';
import { type Arg, type Effects, notSafe } from './types.js';

/**
 * Windows PowerShell 5.1 and PowerShell 7: a parser for the strict subset the classifier accepts. Statements
 * (`;`, newline, `&&`, `||`), pipelines (`|`), parameters (`-Name value`, `-Name:value`), literal and simple
 * double-quoted strings, comma arrays, `( … )` / `$( … )` sub-pipelines in value positions and redirections are
 * understood. Variables, script blocks, splatting, here-strings, type literals, the call / dot-source operators,
 * `--%`, backtick escapes, comments and the typographic quotes and dashes PowerShell also accepts are refused.
 * Parameter names must match exactly (no prefix abbreviations); cmdlets and aliases come from `PS_RULES`.
 */

interface Token {
  readonly kind: 'word' | 'param' | 'group' | 'comma';
  readonly text: string;
  /** `-Name:value` */
  readonly attached?: Token;
  readonly inner?: Program;
}

interface Redirect {
  readonly target: string | null; // null = stream merge (2>&1)
}

interface Command {
  readonly tokens: readonly Token[];
  readonly redirects: readonly Redirect[];
  /** Receives the previous command's output (`a | b`). */
  readonly piped: boolean;
}

type Program = readonly Command[];

/** PowerShell treats these as quotes or dashes too. */
const TYPOGRAPHIC =
  /[\u2018-\u201f\u2013-\u2015\u00a0\u0085\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const WORD_REFUSED = new Set(['$', '`', '@', '{', '}', '[', ']', '#', '!', '<', '"', "'"]);
const WORD_END = new Set([' ', '\t', '\n', ';', '|', '&', '(', ')', ',', '>']);

const RULES = new Map<string, PsRule>();
for (const r of PS_RULES) for (const n of r.names) RULES.set(n.toLowerCase(), r);

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Program {
    const program = this.program(false);
    if (this.pos !== this.src.length) notSafe('parse_error');
    return program;
  }

  private peek(n = 0): string {
    return this.src.charAt(this.pos + n);
  }

  private blanks(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  private program(nested: boolean): Program {
    const commands: Command[] = [];
    let expect = true;
    let afterOperator = false;
    let piped = false;
    for (;;) {
      this.blanks();
      const c = this.peek();
      if (c === '' || c === ')') {
        if (c === '' && nested) notSafe('unterminated_group');
        if (c === ')' && !nested) notSafe('parse_error');
        if (afterOperator) notSafe('parse_error');
        break;
      }
      if (c === ';' || c === '\n') {
        if (afterOperator) notSafe('parse_error');
        this.pos++;
        expect = true;
        piped = false;
        continue;
      }
      if (c === '|' || c === '&') {
        const two = this.src.slice(this.pos, this.pos + 2);
        piped = false;
        if (two === '&&' || two === '||') this.pos += 2;
        else if (c === '|') {
          this.pos += 1;
          piped = true;
        } else notSafe('call_or_background_operator');
        if (expect) notSafe('parse_error');
        expect = true;
        afterOperator = true;
        continue;
      }
      if (!expect) notSafe('parse_error');
      commands.push(this.command(piped));
      expect = false;
      afterOperator = false;
      piped = false;
    }
    return commands;
  }

  private command(piped: boolean): Command {
    const tokens: Token[] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      this.blanks();
      const c = this.peek();
      if (c === '' || c === ';' || c === '\n' || c === '|' || c === ')') break;
      if (c === '&') {
        if (this.peek(1) === '&') break;
        notSafe('call_or_background_operator');
      }
      const redirect = this.redirect();
      if (redirect !== null) {
        redirects.push(redirect);
        continue;
      }
      if (c === '<') notSafe('input_redirection');
      if (c === ',') {
        this.pos++;
        tokens.push({ kind: 'comma', text: ',' });
        continue;
      }
      tokens.push(this.token(tokens.length === 0));
    }
    if (tokens.length === 0) notSafe('empty_command');
    return { tokens, redirects, piped };
  }

  private redirect(): Redirect | null {
    const m = /^([1-6*]?)(>>|>)(&[12])?/.exec(this.src.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    if (m[3] !== undefined) return { target: null };
    this.blanks();
    if (this.src.startsWith('$null', this.pos) && WORD_END.has(this.peek(5) || ' ')) {
      this.pos += 5;
      return { target: '$null' };
    }
    const t = this.token(false);
    if (t.kind !== 'word') notSafe('redirect_target');
    return { target: t.text };
  }

  private group(): Token {
    // `(` or `$(`: a sub-pipeline whose output becomes one value.
    this.pos += this.peek() === '$' ? 2 : 1;
    const inner = this.program(true);
    this.pos++; // ')'
    const next = this.peek();
    if (next !== '' && !WORD_END.has(next)) notSafe('member_access');
    return { kind: 'group', text: '(…)', inner };
  }

  private token(commandPosition: boolean): Token {
    const c = this.peek();
    if (c === '(' || (c === '$' && this.peek(1) === '(')) {
      if (commandPosition) notSafe('expression_statement');
      return this.group();
    }
    if (c === '-' && !commandPosition && /[A-Za-z]/.test(this.peek(1))) {
      const m = /^-([A-Za-z][A-Za-z0-9]*)(:?)/.exec(this.src.slice(this.pos));
      if (!m) notSafe('parse_error');
      this.pos += m[0].length;
      const name = m[1] ?? '';
      const next = this.peek();
      if (m[2] === ':') {
        if (next === '' || next === ' ' || next === '\t') {
          this.blanks();
        }
        return { kind: 'param', text: name, attached: this.token(false) };
      }
      if (next !== '' && !WORD_END.has(next)) notSafe('parse_error');
      return { kind: 'param', text: name };
    }
    if (c === '-' && this.peek(1) === '-' && !/[A-Za-z]/.test(this.peek(2))) {
      notSafe('stop_parsing_or_end_of_parameters'); // `--%` and a bare `--`
    }
    return this.word(commandPosition);
  }

  private word(commandPosition: boolean): Token {
    let text = '';
    const start = this.pos;
    let quotedStart = false;
    for (;;) {
      const c = this.peek();
      if (c === '' || WORD_END.has(c)) break;
      if (c === "'") {
        if (this.pos === start) quotedStart = true;
        this.pos++;
        for (;;) {
          const d = this.peek();
          if (d === '') notSafe('unterminated_quote');
          if (d === "'") {
            if (this.peek(1) === "'") {
              text += "'";
              this.pos += 2;
              continue;
            }
            this.pos++;
            break;
          }
          text += d;
          this.pos++;
        }
        continue;
      }
      if (c === '"') {
        if (this.pos === start) quotedStart = true;
        this.pos++;
        for (;;) {
          const d = this.peek();
          if (d === '') notSafe('unterminated_quote');
          if (d === '"') {
            if (this.peek(1) === '"') {
              text += '"';
              this.pos += 2;
              continue;
            }
            this.pos++;
            break;
          }
          if (d === '$' || d === '`') notSafe('expansion_in_quotes');
          text += d;
          this.pos++;
        }
        continue;
      }
      if (WORD_REFUSED.has(c)) notSafe(`unquoted_${c}`);
      if (c.charCodeAt(0) > 0x7e) notSafe('non_ascii');
      text += c;
      this.pos++;
    }
    if (this.pos === start) notSafe('parse_error');
    if (commandPosition && quotedStart) notSafe('expression_statement');
    if (commandPosition && text === '.') notSafe('dot_source');
    return { kind: 'word', text };
  }
}

/** A value: one word, an array (`a,b`) or a sub-pipeline. */
interface Value {
  readonly items: readonly string[];
  readonly dynamic: boolean;
}

function values(tokens: readonly Token[], fx: Effects): (Value | { param: string; attached?: Value })[] {
  const out: (Value | { param: string; attached?: Value })[] = [];
  const asValue = (t: Token): Value => {
    if (t.kind === 'group') {
      classifyProgram(t.inner ?? [], fx);
      return { items: [], dynamic: true };
    }
    if (t.kind !== 'word') notSafe('parse_error');
    return { items: [t.text], dynamic: false };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t.kind === 'comma') notSafe('parse_error');
    if (t.kind === 'param') {
      out.push({ param: t.text, ...(t.attached ? { attached: asValue(t.attached) } : {}) });
      continue;
    }
    let v = asValue(t);
    while (tokens[i + 1]?.kind === 'comma') {
      const next = tokens[i + 2];
      if (next === undefined || next.kind === 'param' || next.kind === 'comma') notSafe('parse_error');
      const w = asValue(next);
      v = { items: [...v.items, ...w.items], dynamic: v.dynamic || w.dynamic };
      i += 2;
    }
    out.push(v);
  }
  return out;
}

function applyRole(rule: PsRule, param: string, v: Value, fx: Effects): void {
  const role = rule.params[param];
  if (role === undefined) notSafe('ps_parameter');
  if (role === 'switch') notSafe('ps_switch_value');
  if (typeof role === 'object') {
    if (v.dynamic || v.items.length !== 1) notSafe('ps_enum_value');
    const item = (v.items[0] ?? '').toLowerCase();
    if (!role.oneOf.some((o) => o.toLowerCase() === item)) notSafe('ps_enum_value');
    return;
  }
  if (role === 'data' || role === 'pattern') return;
  if (v.dynamic) notSafe('dynamic_path');
  for (const item of v.items) fx.apply(role, { text: item, dynamic: false });
}

function checkCmdlet(rule: PsRule, tokens: readonly Token[], fx: Effects): void {
  fx.rules.add(rule.id);
  const items = values(tokens, fx);
  const bound = new Map<string, Value>();
  const positional: Value[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === undefined) break;
    if (!('param' in it)) {
      positional.push(it);
      continue;
    }
    const name = it.param.toLowerCase();
    const role = rule.params[name];
    if (role === undefined) notSafe(`ps_parameter:${name.slice(0, 40)}`);
    if (bound.has(name)) notSafe('ps_parameter_twice');
    if (role === 'switch') {
      if (it.attached !== undefined) notSafe('ps_switch_value');
      bound.set(name, { items: [], dynamic: false });
      continue;
    }
    let v = it.attached;
    if (v === undefined) {
      const next = items[i + 1];
      if (next === undefined || 'param' in next) notSafe('missing_parameter_value');
      v = next;
      i++;
    }
    bound.set(name, v);
  }
  const slots = rule.positional.filter((p) => p === '*' || !bound.has(p));
  for (const [idx, v] of positional.entries()) {
    const slot = slots[Math.min(idx, slots.length - 1)];
    if (slot === undefined || (idx >= slots.length && slot !== '*')) notSafe('too_many_operands');
    if (slot === '*') continue; // data
    bound.set(slot, v);
  }
  if (rule.id === 'ps.New-Item') {
    const name = bound.get('name');
    const base = bound.get('path');
    for (const [p, v] of bound) {
      if (p !== 'name' && p !== 'path' && rule.params[p] !== 'switch') applyRole(rule, p, v, fx);
    }
    if (name !== undefined) {
      if (name.dynamic || name.items.length !== 1) notSafe('dynamic_path');
      const n = name.items[0] ?? '';
      if (n === '' || n === '.' || n === '..' || /[\\/:]/.test(n)) notSafe('ps_item_name');
      const bases = base === undefined ? ['.'] : base.dynamic ? notSafe('dynamic_path') : base.items;
      for (const b of bases) fx.write(`${b.replace(/[\\/]+$/, '')}\\${n}`);
    } else {
      if (base === undefined) notSafe('missing_path');
      applyRole(rule, 'path', base, fx);
    }
    return;
  }
  for (const [p, v] of bound) {
    if (rule.params[p] === 'switch') continue;
    applyRole(rule, p, v, fx);
  }
  if (rule.effect === 'write' && ![...bound.keys()].some((k) => k === 'path' || k.endsWith('path'))) {
    notSafe('missing_path');
  }
}

/**
 * Cmdlets that bind a path from pipeline objects (`PSPath` / `Path` by property name; FileInfo for Select-String).
 * Downstream of Get-ChildItem they would act on children nobody checked — a symlink among them may point anywhere.
 */
const PIPELINE_PATH_CMDLETS = new Set([
  'ps.Get-Content',
  'ps.Select-String',
  'ps.Set-Content',
  'ps.Get-Item',
  'ps.Test-Path',
  'ps.New-Item',
  'ps.mkdir',
]);

function classifyProgram(program: Program, fx: Effects): void {
  let listedItems = false;
  for (const cmd of program) {
    if (!cmd.piped) listedItems = false;
    for (const r of cmd.redirects) {
      if (r.target === null || r.target.toLowerCase() === '$null') {
        fx.rules.add('redirect.null');
        continue;
      }
      fx.rules.add('redirect.write');
      fx.write(r.target);
    }
    const [head, ...rest] = cmd.tokens;
    if (head?.kind !== 'word' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(head.text)) notSafe('command_name');
    const name = head.text.toLowerCase();
    if (name === 'git') {
      const args: Arg[] = rest.map((t) => {
        if (t.kind === 'group' || t.kind === 'comma') notSafe('dynamic_argument');
        if (t.kind === 'param') {
          if (t.attached !== undefined) notSafe('parse_error');
          return { text: `-${t.text}`, dynamic: false };
        }
        return { text: t.text, dynamic: false };
      });
      checkGit(args, fx);
      continue;
    }
    const rule = RULES.get(name);
    if (rule === undefined) notSafe(`unknown_command:${name.slice(0, 40)}`);
    if (listedItems && PIPELINE_PATH_CMDLETS.has(rule.id)) notSafe('pipeline_path_binding');
    if (rule.id === 'ps.Get-ChildItem') listedItems = true;
    checkCmdlet(rule, rest, fx);
  }
}

export function classifyPowerShell(command: string, fx: Effects): void {
  if (TYPOGRAPHIC.test(command)) notSafe('typographic_quote_or_dash');
  classifyProgram(new Parser(command).parse(), fx);
}
