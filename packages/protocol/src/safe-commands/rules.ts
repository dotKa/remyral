import type { ArgRole, SafeVerdict, ShellFamily } from './types.js';

/**
 * The safe-command allowlist (p6-safe-auto-approve). Data, not code: the validators in `posix.ts`,
 * `powershell.ts`, `cmd.ts` and `git.ts` read these tables, and the console shows them on the project Policy
 * tab. Anything not listed here is not safe. Adding a command is a reviewed code change (security review section of
 * docs/design/p6-safe-auto-approve.md): list its options that write, execute, follow symlinks or reach the
 * network as `forbidden`, and give every option that takes a file its role.
 */

// ------------------------------------------------------------------------------------------------ POSIX

export interface PosixRule {
  readonly id: string;
  readonly names: readonly string[];
  readonly effect: 'read' | 'write';
  readonly summary: string;
  /** How operands are used. */
  readonly positional: 'paths' | 'wpaths' | 'data' | 'pattern-then-paths' | 'none';
  readonly maxPositional?: number;
  /** Short options that take a value (`-f FILE`, `-fFILE`) and the value's role. */
  readonly shortValue?: Readonly<Record<string, ArgRole>>;
  /** Long options that take a value (`--file=F`, `--file F`; GNU-style unambiguous prefixes too). */
  readonly longValue?: Readonly<Record<string, ArgRole>>;
  /** Options that make the command write, run programs, follow symlinks or hang. Long ones match by prefix. */
  readonly forbidden?: readonly string[];
  /** Every argument is data (no option parsing). */
  readonly noOptions?: boolean;
  /** No argument at all. */
  readonly noArgs?: boolean;
  /** Each operand must start with this (date: `+FORMAT`; anything else sets the clock). */
  readonly operandPrefix?: string;
}

export const POSIX_RULES: readonly PosixRule[] = [
  {
    id: 'posix.ls',
    names: ['ls'],
    effect: 'read',
    summary: 'List directory contents',
    positional: 'paths',
    shortValue: { I: 'pattern', w: 'data', T: 'data' },
    longValue: {
      '--ignore': 'pattern',
      '--hide': 'pattern',
      '--width': 'data',
      '--tabsize': 'data',
      '--format': 'data',
      '--sort': 'data',
      '--time': 'data',
      '--time-style': 'data',
      '--color': 'data',
      '--block-size': 'data',
      '--indicator-style': 'data',
      '--quoting-style': 'data',
    },
    forbidden: ['--dereference', '-L', '--hyperlink'],
  },
  {
    id: 'posix.cat',
    names: ['cat'],
    effect: 'read',
    summary: 'Print files',
    positional: 'paths',
  },
  {
    id: 'posix.head',
    names: ['head'],
    effect: 'read',
    summary: 'First lines of files',
    positional: 'paths',
    shortValue: { n: 'data', c: 'data' },
    longValue: { '--lines': 'data', '--bytes': 'data' },
  },
  {
    id: 'posix.tail',
    names: ['tail'],
    effect: 'read',
    summary: 'Last lines of files (not -f: it never ends)',
    positional: 'paths',
    shortValue: { n: 'data', c: 'data', s: 'data' },
    longValue: { '--lines': 'data', '--bytes': 'data' },
    forbidden: ['-f', '-F', '--follow', '--pid', '--retry'],
  },
  {
    id: 'posix.wc',
    names: ['wc'],
    effect: 'read',
    summary: 'Count lines, words and bytes',
    positional: 'paths',
    forbidden: ['--files0-from'],
  },
  {
    id: 'posix.grep',
    names: ['grep', 'egrep', 'fgrep'],
    effect: 'read',
    summary: 'Search file contents (not -R: it follows symlinks)',
    positional: 'pattern-then-paths',
    shortValue: {
      e: 'pattern',
      f: 'path',
      m: 'data',
      A: 'data',
      B: 'data',
      C: 'data',
      d: 'data',
      D: 'data',
    },
    longValue: {
      '--regexp': 'pattern',
      '--file': 'path',
      '--max-count': 'data',
      '--after-context': 'data',
      '--before-context': 'data',
      '--context': 'data',
      '--include': 'pattern',
      '--exclude': 'pattern',
      '--exclude-dir': 'pattern',
      '--exclude-from': 'path',
      '--label': 'data',
      '--color': 'data',
      '--colour': 'data',
      '--binary-files': 'data',
      '--directories': 'data',
      '--devices': 'data',
      '--group-separator': 'data',
    },
    forbidden: ['-R', '--dereference-recursive'],
  },
  {
    id: 'posix.rg',
    names: ['rg'],
    effect: 'read',
    summary: 'ripgrep search (no --pre, -z, -L or --hostname-bin: they run programs or follow symlinks)',
    positional: 'pattern-then-paths',
    shortValue: {
      e: 'pattern',
      f: 'path',
      g: 'pattern',
      t: 'data',
      T: 'data',
      m: 'data',
      A: 'data',
      B: 'data',
      C: 'data',
      M: 'data',
      j: 'data',
      r: 'data',
      E: 'data',
      d: 'data',
    },
    longValue: {
      '--regexp': 'pattern',
      '--file': 'path',
      '--glob': 'pattern',
      '--iglob': 'pattern',
      '--type': 'data',
      '--type-not': 'data',
      '--max-count': 'data',
      '--after-context': 'data',
      '--before-context': 'data',
      '--context': 'data',
      '--max-columns': 'data',
      '--threads': 'data',
      '--replace': 'data',
      '--encoding': 'data',
      '--max-depth': 'data',
      '--color': 'data',
      '--sort': 'data',
      '--sortr': 'data',
      '--ignore-file': 'path',
      '--max-filesize': 'data',
      '--path-separator': 'data',
      '--field-match-separator': 'data',
      '--field-context-separator': 'data',
      '--context-separator': 'data',
    },
    forbidden: [
      '--pre',
      '--pre-glob',
      '-z',
      '--search-zip',
      '-L',
      '--follow',
      '--hostname-bin',
      '--type-add',
      '--engine',
      '--dfa-size-limit',
    ],
  },
  {
    id: 'posix.find',
    names: ['find'],
    effect: 'read',
    summary: 'Find files (no -exec, -execdir, -ok, -delete, -fprint, -fls, -L, -H or -follow)',
    positional: 'paths',
    forbidden: [
      '-exec',
      '-execdir',
      '-ok',
      '-okdir',
      '-delete',
      '-fprint',
      '-fprint0',
      '-fprintf',
      '-fls',
      '-L',
      '-H',
      '-follow',
      '-files0-from',
      '-newer',
      '-anewer',
      '-cnewer',
      '-samefile',
      '-D',
    ],
  },
  {
    id: 'posix.stat',
    names: ['stat'],
    effect: 'read',
    summary: 'File status',
    positional: 'paths',
    shortValue: { c: 'data' },
    longValue: { '--format': 'data', '--printf': 'data' },
    forbidden: ['-L', '--dereference'],
  },
  {
    id: 'posix.du',
    names: ['du'],
    effect: 'read',
    summary: 'Disk usage',
    positional: 'paths',
    shortValue: { d: 'data', B: 'data', t: 'data' },
    longValue: {
      '--max-depth': 'data',
      '--block-size': 'data',
      '--threshold': 'data',
      '--exclude': 'pattern',
      '--time': 'data',
      '--time-style': 'data',
    },
    forbidden: ['--files0-from', '-X', '--exclude-from', '-L', '--dereference'],
  },
  {
    id: 'posix.tree',
    names: ['tree'],
    effect: 'read',
    summary: 'Directory tree (not -o: it writes a file; not -l: it follows symlinks)',
    positional: 'paths',
    shortValue: { L: 'data', I: 'pattern', P: 'pattern', H: 'data', T: 'data' },
    forbidden: ['-o', '-l', '--fromfile', '-R'],
  },
  {
    id: 'posix.diff',
    names: ['diff'],
    effect: 'read',
    summary: 'Compare files',
    positional: 'paths',
    shortValue: { U: 'data', C: 'data', x: 'pattern', X: 'path', I: 'pattern', W: 'data', F: 'pattern' },
    longValue: {
      '--unified': 'data',
      '--context': 'data',
      '--exclude': 'pattern',
      '--exclude-from': 'path',
      '--ignore-matching-lines': 'pattern',
      '--width': 'data',
      '--label': 'data',
      '--color': 'data',
      '--from-file': 'path',
      '--to-file': 'path',
      '--show-function-line': 'pattern',
      '--line-format': 'data',
      '--palette': 'data',
    },
  },
  {
    id: 'posix.sort',
    names: ['sort'],
    effect: 'read',
    summary: 'Sort lines (not -o, -T or --compress-program)',
    positional: 'paths',
    shortValue: { k: 'data', t: 'data', S: 'data' },
    longValue: { '--key': 'data', '--field-separator': 'data', '--buffer-size': 'data', '--sort': 'data' },
    forbidden: [
      '-o',
      '--output',
      '-T',
      '--temporary-directory',
      '--compress-program',
      '--files0-from',
      '--random-source',
      '--parallel',
    ],
  },
  {
    id: 'posix.uniq',
    names: ['uniq'],
    effect: 'read',
    summary: 'Filter repeated lines (one input file; a second operand would be written)',
    positional: 'paths',
    maxPositional: 1,
    shortValue: { f: 'data', s: 'data', w: 'data' },
    longValue: {
      '--skip-fields': 'data',
      '--skip-chars': 'data',
      '--check-chars': 'data',
      '--group': 'data',
    },
  },
  {
    id: 'posix.cut',
    names: ['cut'],
    effect: 'read',
    summary: 'Select columns',
    positional: 'paths',
    shortValue: { d: 'data', f: 'data', b: 'data', c: 'data' },
    longValue: {
      '--delimiter': 'data',
      '--fields': 'data',
      '--bytes': 'data',
      '--characters': 'data',
      '--output-delimiter': 'data',
    },
  },
  {
    id: 'posix.tr',
    names: ['tr'],
    effect: 'read',
    summary: 'Translate characters (standard input only)',
    positional: 'data',
    maxPositional: 2,
  },
  {
    id: 'posix.echo',
    names: ['echo'],
    effect: 'read',
    summary: 'Print text',
    positional: 'data',
    noOptions: true,
  },
  {
    id: 'posix.printf',
    names: ['printf'],
    effect: 'read',
    summary: 'Print formatted text (not -v: it sets a variable)',
    positional: 'data',
    forbidden: ['-v'],
  },
  {
    id: 'posix.basename',
    names: ['basename', 'dirname'],
    effect: 'read',
    summary: 'Strip a path (text only)',
    positional: 'data',
    shortValue: { s: 'data' },
    longValue: { '--suffix': 'data' },
  },
  {
    id: 'posix.pwd',
    names: ['pwd'],
    effect: 'read',
    summary: 'Print the working directory',
    positional: 'none',
  },
  {
    id: 'posix.date',
    names: ['date'],
    effect: 'read',
    summary: 'Print the date (+FORMAT only; not -s, --set or -f)',
    positional: 'data',
    operandPrefix: '+',
    shortValue: { d: 'data', r: 'path', I: 'data' },
    longValue: { '--date': 'data', '--reference': 'path', '--iso-8601': 'data', '--rfc-3339': 'data' },
    forbidden: ['-s', '--set', '-f', '--file'],
  },
  {
    id: 'posix.uname',
    names: ['uname'],
    effect: 'read',
    summary: 'Operating system name',
    positional: 'none',
  },
  {
    id: 'posix.whoami',
    names: ['whoami', 'hostname'],
    effect: 'read',
    summary: 'User or host name (no arguments: `hostname NAME` renames the machine)',
    positional: 'none',
    noArgs: true,
  },
  {
    id: 'posix.mkdir',
    names: ['mkdir'],
    effect: 'write',
    summary: 'Create directories inside the workspace',
    positional: 'wpaths',
    shortValue: { m: 'data' },
    longValue: { '--mode': 'data' },
    forbidden: ['-Z', '--context'],
  },
  {
    id: 'posix.touch',
    names: ['touch'],
    effect: 'write',
    summary: 'Create files / set times inside the workspace',
    positional: 'wpaths',
    shortValue: { r: 'path', d: 'data', t: 'data' },
    longValue: { '--reference': 'path', '--date': 'data', '--time': 'data' },
  },
  {
    id: 'posix.tee',
    names: ['tee'],
    effect: 'write',
    summary: 'Copy standard input to files inside the workspace',
    positional: 'wpaths',
    longValue: { '--output-error': 'data' },
  },
];

// ------------------------------------------------------------------------------------------------ git

export const GIT_READ_SUBCOMMANDS: readonly string[] = [
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
];

/** Options of the read-only git subcommands that write files, run programs or leave the repository. */
export const GIT_FORBIDDEN: readonly string[] = [
  '--output',
  '--ext-diff',
  '--textconv',
  '--no-index',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--open-files-in-pager',
  '--git-dir',
  '--work-tree',
  '--config-env',
  '-O',
];

/** `git branch` is read-only only with these options (no create, delete, move, copy, upstream or edit). */
export const GIT_BRANCH_ALLOWED: readonly string[] = [
  '--list',
  '-l',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--show-current',
  '--no-color',
  '--color',
  '--format',
  '--sort',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--column',
  '--no-column',
  '-i',
  '--ignore-case',
];

// ------------------------------------------------------------------------------------------------ PowerShell

/** A PowerShell parameter: its role, or `switch` (no value), or a closed set of values. */
export type PsParamRole = ArgRole | 'switch' | { readonly oneOf: readonly string[] };

export interface PsRule {
  readonly id: string;
  /** Cmdlet name and the aliases that exist in both Windows PowerShell 5.1 and PowerShell 7 on Windows. */
  readonly names: readonly string[];
  readonly effect: 'read' | 'write';
  readonly summary: string;
  /** Exhaustive: a parameter not listed here (exact name, any case) is not safe. */
  readonly params: Readonly<Record<string, PsParamRole>>;
  /** Positional binding order (parameter names from `params`); `*` = every further positional is data. */
  readonly positional: readonly string[];
  /** `mkdir` / `md`: always creates a directory. */
  readonly forceDirectory?: boolean;
}

const PATH = 'path' as const;
const WPATH = 'wpath' as const;
const DATA = 'data' as const;
const PATTERN = 'pattern' as const;
const SWITCH = 'switch' as const;

/** WMI / CIM classes that only describe the machine (no secrets, no remote calls). */
export const CIM_CLASSES: readonly string[] = [
  'Win32_OperatingSystem',
  'Win32_ComputerSystem',
  'Win32_Processor',
  'Win32_LogicalDisk',
  'Win32_BIOS',
  'Win32_PhysicalMemory',
  'Win32_VideoController',
];

export const PS_RULES: readonly PsRule[] = [
  {
    id: 'ps.Get-ChildItem',
    names: ['Get-ChildItem', 'gci', 'ls', 'dir'],
    effect: 'read',
    summary: 'List directory contents (not -FollowSymlink)',
    params: {
      path: PATH,
      literalpath: PATH,
      filter: PATTERN,
      include: PATTERN,
      exclude: PATTERN,
      recurse: SWITCH,
      depth: DATA,
      force: SWITCH,
      name: SWITCH,
      directory: SWITCH,
      file: SWITCH,
      hidden: SWITCH,
      readonly: SWITCH,
      system: SWITCH,
      attributes: DATA,
    },
    positional: ['path', 'filter'],
  },
  {
    id: 'ps.Get-Content',
    names: ['Get-Content', 'gc', 'cat', 'type'],
    effect: 'read',
    summary: 'Print files (not -Wait or -Stream)',
    params: {
      path: PATH,
      literalpath: PATH,
      totalcount: DATA,
      head: DATA,
      first: DATA,
      tail: DATA,
      last: DATA,
      raw: SWITCH,
      encoding: DATA,
      readcount: DATA,
      delimiter: DATA,
    },
    positional: ['path'],
  },
  {
    id: 'ps.Get-Item',
    names: ['Get-Item', 'gi'],
    effect: 'read',
    summary: 'File or directory information',
    params: { path: PATH, literalpath: PATH, force: SWITCH },
    positional: ['path'],
  },
  {
    id: 'ps.Test-Path',
    names: ['Test-Path'],
    effect: 'read',
    summary: 'Whether a path exists',
    params: {
      path: PATH,
      literalpath: PATH,
      pathtype: { oneOf: ['Any', 'Container', 'Leaf'] },
      isvalid: SWITCH,
    },
    positional: ['path'],
  },
  {
    id: 'ps.Select-String',
    names: ['Select-String', 'sls'],
    effect: 'read',
    summary: 'Search file contents',
    params: {
      pattern: PATTERN,
      path: PATH,
      literalpath: PATH,
      simplematch: SWITCH,
      casesensitive: SWITCH,
      notmatch: SWITCH,
      allmatches: SWITCH,
      list: SWITCH,
      quiet: SWITCH,
      raw: SWITCH,
      noemphasis: SWITCH,
      context: DATA,
      encoding: DATA,
      include: PATTERN,
      exclude: PATTERN,
    },
    positional: ['pattern', 'path'],
  },
  {
    id: 'ps.Get-Location',
    names: ['Get-Location', 'gl', 'pwd'],
    effect: 'read',
    summary: 'Print the working directory',
    params: {},
    positional: [],
  },
  {
    id: 'ps.Get-Date',
    names: ['Get-Date'],
    effect: 'read',
    summary: 'Print the date (Set-Date is not allowed)',
    params: { format: DATA, uformat: DATA, date: DATA, asutc: SWITCH },
    positional: ['date'],
  },
  {
    id: 'ps.Get-CimInstance',
    names: ['Get-CimInstance'],
    effect: 'read',
    summary: `Machine description classes only (${CIM_CLASSES.join(', ')}); no -ComputerName, -CimSession or -Query`,
    params: { classname: { oneOf: CIM_CLASSES }, property: DATA },
    positional: ['classname'],
  },
  {
    id: 'ps.Write-Output',
    names: ['Write-Output', 'echo'],
    effect: 'read',
    summary: 'Print text',
    params: { inputobject: DATA, noenumerate: SWITCH },
    positional: ['*'],
  },
  {
    id: 'ps.Write-Host',
    names: ['Write-Host'],
    effect: 'read',
    summary: 'Print text to the host',
    params: {
      object: DATA,
      nonewline: SWITCH,
      separator: DATA,
      foregroundcolor: DATA,
      backgroundcolor: DATA,
    },
    positional: ['*'],
  },
  {
    id: 'ps.Select-Object',
    names: ['Select-Object', 'select'],
    effect: 'read',
    summary: 'Pick properties or items of the pipeline (names only, no script blocks)',
    params: {
      first: DATA,
      last: DATA,
      skip: DATA,
      unique: SWITCH,
      property: DATA,
      expandproperty: DATA,
      excludeproperty: DATA,
      index: DATA,
    },
    positional: ['property'],
  },
  {
    id: 'ps.Sort-Object',
    names: ['Sort-Object', 'sort'],
    effect: 'read',
    summary: 'Sort the pipeline (property names only)',
    params: {
      property: DATA,
      descending: SWITCH,
      unique: SWITCH,
      top: DATA,
      bottom: DATA,
      casesensitive: SWITCH,
    },
    positional: ['property'],
  },
  {
    id: 'ps.Measure-Object',
    names: ['Measure-Object', 'measure'],
    effect: 'read',
    summary: 'Count or measure the pipeline',
    params: {
      property: DATA,
      line: SWITCH,
      word: SWITCH,
      character: SWITCH,
      sum: SWITCH,
      average: SWITCH,
      maximum: SWITCH,
      minimum: SWITCH,
    },
    positional: ['property'],
  },
  {
    id: 'ps.Format',
    names: ['Format-Table', 'ft', 'Format-List', 'fl'],
    effect: 'read',
    summary: 'Format the pipeline (property names only)',
    params: { property: DATA, autosize: SWITCH, wrap: SWITCH, hidetableheaders: SWITCH },
    positional: ['property'],
  },
  {
    id: 'ps.Out-String',
    names: ['Out-String', 'Out-Null'],
    effect: 'read',
    summary: 'Turn the pipeline into text, or discard it',
    params: { width: DATA, stream: SWITCH },
    positional: [],
  },
  {
    id: 'ps.New-Item',
    names: ['New-Item', 'ni'],
    effect: 'write',
    summary: 'Create a file or directory inside the workspace (-ItemType File or Directory only)',
    params: {
      path: WPATH,
      name: DATA,
      itemtype: { oneOf: ['File', 'Directory'] },
      type: { oneOf: ['File', 'Directory'] },
      value: DATA,
      force: SWITCH,
    },
    positional: ['path'],
  },
  {
    id: 'ps.mkdir',
    names: ['mkdir', 'md'],
    effect: 'write',
    summary: 'Create a directory inside the workspace',
    params: { path: WPATH, force: SWITCH },
    positional: ['path'],
    forceDirectory: true,
  },
  {
    id: 'ps.Set-Content',
    names: ['Set-Content', 'Add-Content'],
    effect: 'write',
    summary: 'Write or append text to a file inside the workspace (not -Stream)',
    params: {
      path: WPATH,
      literalpath: WPATH,
      value: DATA,
      encoding: DATA,
      nonewline: SWITCH,
      force: SWITCH,
    },
    positional: ['path', 'value'],
  },
  {
    id: 'ps.Out-File',
    names: ['Out-File'],
    effect: 'write',
    summary: 'Write the pipeline to a file inside the workspace',
    params: {
      filepath: WPATH,
      literalpath: WPATH,
      encoding: DATA,
      append: SWITCH,
      noclobber: SWITCH,
      nonewline: SWITCH,
      force: SWITCH,
      width: DATA,
      inputobject: DATA,
    },
    positional: ['filepath', 'encoding'],
  },
];

// ------------------------------------------------------------------------------------------------ cmd

export interface CmdRule {
  readonly id: string;
  readonly names: readonly string[];
  readonly effect: 'read' | 'write';
  readonly summary: string;
  readonly positional: 'paths' | 'wpaths' | 'data' | 'pattern-then-paths' | 'none';
  /** Allowed switches (`/X`, case-insensitive, without the slash). `X:` = takes a value after the colon. */
  readonly switches: Readonly<Record<string, ArgRole | 'flag'>>;
  /** Exactly these arguments (date /t). */
  readonly exactArgs?: readonly string[];
}

export const CMD_RULES: readonly CmdRule[] = [
  {
    id: 'cmd.dir',
    names: ['dir'],
    effect: 'read',
    summary: 'List directory contents (not /p)',
    positional: 'paths',
    switches: {
      a: 'flag',
      b: 'flag',
      s: 'flag',
      o: 'flag',
      w: 'flag',
      d: 'flag',
      l: 'flag',
      n: 'flag',
      q: 'flag',
      t: 'flag',
      x: 'flag',
      c: 'flag',
      '4': 'flag',
    },
  },
  {
    id: 'cmd.type',
    names: ['type'],
    effect: 'read',
    summary: 'Print files',
    positional: 'paths',
    switches: {},
  },
  {
    id: 'cmd.findstr',
    names: ['findstr'],
    effect: 'read',
    summary: 'Search file contents (not /d)',
    positional: 'pattern-then-paths',
    switches: {
      b: 'flag',
      e: 'flag',
      l: 'flag',
      r: 'flag',
      s: 'flag',
      i: 'flag',
      x: 'flag',
      v: 'flag',
      n: 'flag',
      m: 'flag',
      o: 'flag',
      p: 'flag',
      offline: 'flag',
      a: 'data',
      c: 'pattern',
      g: 'path',
      f: 'path',
    },
  },
  {
    id: 'cmd.echo',
    names: ['echo'],
    effect: 'read',
    summary: 'Print text',
    positional: 'data',
    switches: {},
  },
  {
    id: 'cmd.ver',
    names: ['ver'],
    effect: 'read',
    summary: 'Windows version',
    positional: 'none',
    switches: {},
  },
  {
    id: 'cmd.date',
    names: ['date', 'time'],
    effect: 'read',
    summary: 'Print the date or time (/t only; anything else sets the clock)',
    positional: 'none',
    switches: {},
    exactArgs: ['/t'],
  },
  {
    id: 'cmd.mkdir',
    names: ['mkdir', 'md'],
    effect: 'write',
    summary: 'Create directories inside the workspace',
    positional: 'wpaths',
    switches: {},
  },
];

// ------------------------------------------------------------------------------------------------ catalogue

/** One row of the allowlist as the console shows it. */
export interface SafeCommandRuleView {
  readonly id: string;
  readonly shell: ShellFamily | 'any';
  readonly names: readonly string[];
  /** `read`: allowed in Read-only mode; `workspace_write`: needs Read-only + workspace writes. */
  readonly needs: SafeVerdict;
  readonly summary: string;
}

/** Redirections are rules of their own (they are how most writes happen). */
export const REDIRECT_RULES: readonly SafeCommandRuleView[] = [
  {
    id: 'redirect.read',
    shell: 'any',
    names: ['< file'],
    needs: 'read',
    summary: 'Read standard input from a workspace file',
  },
  {
    id: 'redirect.null',
    shell: 'any',
    names: ['> /dev/null', '2>&1', '> $null', '> nul'],
    needs: 'read',
    summary: 'Discard or merge output streams',
  },
  {
    id: 'redirect.write',
    shell: 'any',
    names: ['> file', '>> file'],
    needs: 'workspace_write',
    summary: 'Write output to a file inside the workspace',
  },
];

export const GIT_RULE: SafeCommandRuleView = {
  id: 'git.read',
  shell: 'any',
  names: GIT_READ_SUBCOMMANDS.map((s) => `git ${s}`),
  needs: 'read',
  summary:
    'Read-only git in the workspace repository: no global options (-c, -C, --git-dir), no --output, --ext-diff, ' +
    '--textconv or --no-index; `git branch` only lists.',
};

/** The whole allowlist, for the console (project Policy tab) and the design note. */
export const SAFE_COMMAND_RULES: readonly SafeCommandRuleView[] = [
  GIT_RULE,
  ...POSIX_RULES.map((r) => ({
    id: r.id,
    shell: 'posix' as const,
    names: r.names,
    needs: r.effect === 'read' ? ('read' as const) : ('workspace_write' as const),
    summary: r.summary,
  })),
  ...PS_RULES.map((r) => ({
    id: r.id,
    shell: 'powershell' as const,
    names: r.names,
    needs: r.effect === 'read' ? ('read' as const) : ('workspace_write' as const),
    summary: r.summary,
  })),
  ...CMD_RULES.map((r) => ({
    id: r.id,
    shell: 'cmd' as const,
    names: r.names,
    needs: r.effect === 'read' ? ('read' as const) : ('workspace_write' as const),
    summary: r.summary,
  })),
  ...REDIRECT_RULES,
];
