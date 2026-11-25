import {
  isSkillPathV2,
  MAX_SKILL_FILE_BYTES_V2,
  MAX_SKILL_FILES_V2,
  MAX_SKILL_TOTAL_BYTES_V2,
  SkillId,
  type SkillLayout,
  skillLayoutOf,
} from '@remyral/protocol';
import { scanForSecrets } from '@remyral/memory';
import { Redactor } from '@remyral/observability';

/**
 * p14-skill-import (docs/design/p14-mcp-skills.md §3.4): turns the raw files of an import (folder, zip, GitHub subtree)
 * into the files of one skill version plus the findings the preview shows. p14-skill-catalogs: the files may use
 * layout v2 (any safe relative text path of ≤ 4 directories, ≤ 64 files / 128 KiB each / 512 KiB total); a skill that
 * still fits today's layout (SKILL.md + scripts/ references/ resources/ assets/, ≤ 32 files / 64 KiB each / 128 KiB)
 * stays layout 1 (every worker takes it), a larger one is layout 2 (an info finding `layout_v2`: only
 * `skills-layout-v2` workers run it).
 *
 * - **blocking**: a secret (rule + position only, never the value), no SKILL.md, an unsafe path, a binary file, a file /
 *   count / total over the v2 limits;
 * - **warnings**: executable content (scripts/, shebangs, script extensions), risky instructions (`curl … | sh`,
 *   `Invoke-Expression`, reading ~/.ssh or cloud credentials, dumping the environment, "ignore previous instructions",
 *   destructive commands, bypassing approvals), hosts the skill talks to, SKILL.md name / description problems;
 * - **info**: skipped hidden / OS files, files moved into the layout (LICENSE → resources/, README.md → references/),
 *   the license.
 *
 * Everything here is data about untrusted content: findings carry codes and short positions, the web renders them
 * with the catalog and shows the files as text. Pure functions (no I/O).
 */

export interface RawImportFile {
  /** Relative POSIX path as found in the source (already checked for traversal by the reader). */
  readonly path: string;
  readonly bytes: Buffer;
}

export type FindingKind =
  // blocking
  | 'secret'
  | 'missing_skill_md'
  | 'layout'
  | 'binary'
  | 'file_too_large'
  | 'too_many_files'
  | 'total_too_large'
  // warnings
  | 'script'
  | 'risky'
  | 'network'
  | 'name_invalid'
  | 'no_description'
  // info
  | 'skipped'
  | 'moved'
  | 'license'
  | 'no_license'
  // p14-skill-catalogs: the skill needs layout v2 (info: only skills-layout-v2 workers run it)
  | 'layout_v2';

export type FindingSeverity = 'block' | 'warn' | 'info';

export interface ImportFinding {
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  readonly path?: string;
  /** 1-based line of the match (secret / risky / script mention). */
  readonly line?: number;
  /** Rule id (secret rule, risky rule) or the reason code of a skipped / moved / layout file. */
  readonly rule?: string;
  /** The target path of a moved file. */
  readonly to?: string;
  /** Hosts found (network). */
  readonly hosts?: string[];
  /** Size in bytes (limits). */
  readonly size?: number;
  /** A short excerpt of the matching line (risky; ≤ 160 characters, untrusted text). Never for secrets. */
  readonly excerpt?: string;
}

export interface ExcludedFile {
  readonly path: string;
  readonly size: number;
  readonly reason: string;
}

export interface ImportAnalysis {
  readonly files: Readonly<Record<string, string>>;
  readonly excluded: readonly ExcludedFile[];
  readonly findings: readonly ImportFinding[];
  readonly blocked: boolean;
  readonly suggested: {
    readonly skillId: string | null;
    readonly title: string | null;
    readonly description: string | null;
  };
  readonly license: { readonly path: string | null; readonly name: string | null } | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** p14-skill-catalogs: 1 = fits today's layout, 2 = needs layout v2 (null: over the v2 limits — blocked). */
  readonly layout: SkillLayout | null;
}

/** Hard cap on what one import may carry before analysis (sources check it while reading). */
export const MAX_IMPORT_RAW_FILES = 256;
export const MAX_IMPORT_RAW_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS = 200;
const MAX_HOSTS = 12;

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|rb|pl|bat|cmd)$/i;
const OS_JUNK = new Set(['thumbs.db', 'desktop.ini', '__macosx']);
const LICENSE_NAME = /^(licen[cs]e|copying|notice)([.-][A-Za-z0-9]{1,16})?$/i;

/** Risky instruction patterns (warnings, not blocking). Ids are stable codes the web translates. */
export const RISKY_RULES: readonly { readonly id: string; readonly re: RegExp }[] = [
  {
    id: 'pipe_to_shell',
    re: /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|pwsh|powershell)\b/i,
  },
  { id: 'invoke_expression', re: /\binvoke-expression\b|\biex\s*[($]/i },
  { id: 'base64_exec', re: /base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash|zsh)\b/i },
  { id: 'ssh_keys', re: /~\/\.ssh\b|\.ssh\/(id_|authorized_keys)|\bid_(rsa|ed25519|ecdsa)\b/i },
  {
    id: 'cloud_credentials',
    re: /\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.netrc\b|\.git-credentials/i,
  },
  {
    id: 'env_dump',
    re: /\bprintenv\b|^\s*(env|set)\s*$|get-childitem\s+env:|\bgci\s+env:|\b(print|show|dump|list|reveal)\s+(all\s+)?(the\s+)?(environment|env)(\s+variables)?\b/im,
  },
  {
    id: 'ignore_instructions',
    re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|system)\b[^\n]{0,24}\b(instructions?|rules|prompts?|polic(y|ies))\b/i,
  },
  {
    id: 'destructive',
    re: /\brm\s+-rf\s+(\/|~|\$home)(\s|$)|\bmkfs(\.\w+)?\b|\bdd\s+if=|\bformat\s+[a-z]:/i,
  },
  {
    id: 'disable_safety',
    re: /--dangerously-skip-permissions|--yolo\b|bypasspermissions|approval[_-]?policy\s*[=:]\s*["']?never|--no-sandbox\b/i,
  },
];

const NETWORK_LINE =
  /\b(curl|wget|fetch|requests\.|httpx|axios|urllib|http\.get|invoke-webrequest|invoke-restmethod)\b/i;
const URL_HOST =
  /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+)/gi;

/** Strips one common leading directory (a folder selection or a zip of a folder) when SKILL.md is below it. */
export function stripCommonRoot(files: readonly RawImportFile[]): RawImportFile[] {
  if (files.length === 0) return [];
  if (files.some((f) => !f.path.includes('/'))) return [...files];
  const first = files[0]?.path.split('/')[0] ?? '';
  if (first === '' || !files.every((f) => f.path.split('/')[0] === first)) return [...files];
  const stripped = files.map((f) => ({ path: f.path.slice(first.length + 1), bytes: f.bytes }));
  // Only strip when the result has SKILL.md at its top (otherwise the folder itself is what is wrong).
  return stripped.some((f) => f.path.toLowerCase() === 'skill.md') ? stripCommonRoot(stripped) : [...files];
}

function isUtf8Text(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  // Invalid UTF-8 decodes to U+FFFD and no longer round-trips; NUL marks a binary file.
  if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(bytes)) return null;
  return text;
}

/** Minimal frontmatter reader for `name`, `description`, `license` (single-line or `>` / `|` block values). */
export function readFrontmatter(skillMd: string): Readonly<Record<string, string>> {
  const m = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(skillMd);
  if (m === null) return {};
  const out: Record<string, string> = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]{0,40}):\s*(.*)$/.exec(lines[i] ?? '');
    if (kv === null) continue;
    const key = (kv[1] ?? '').toLowerCase();
    let value = (kv[2] ?? '').trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) {
        i += 1;
        block.push((lines[i] ?? '').trim());
      }
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else if (/^(['"]).*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** A skill id from free text: lowercase letters, digits, single hyphens, ≤ 64. */
export function slugSkillId(text: string): string | null {
  const s = text
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return SkillId.safeParse(s).success ? s : null;
}

function licenseName(text: string): string | null {
  const head = text.slice(0, 2000);
  const known: readonly [RegExp, string][] = [
    [/\bMIT License\b|Permission is hereby granted, free of charge/i, 'MIT'],
    [/Apache License,?\s+Version 2\.0/i, 'Apache-2.0'],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0'],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, 'GPL-2.0'],
    [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL'],
    [/Mozilla Public License,?\s+(v\.?|version)\s*2\.0/i, 'MPL-2.0'],
    [/BSD 3-Clause|Redistribution and use in source and binary forms/i, 'BSD'],
    [/CC0|Creative Commons Zero/i, 'CC0-1.0'],
    [/Creative Commons Attribution/i, 'CC-BY'],
    [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
  ];
  for (const [re, name] of known) if (re.test(head)) return name;
  const first = head.split(/\r?\n/).find((l) => l.trim() !== '');
  return first === undefined ? null : first.trim().slice(0, 80);
}

const excerptRedactor = new Redactor();

/** A short excerpt of a risky line — redacted first, so a token on the same line never reaches the preview. */
function excerpt(line: string): string {
  const t = excerptRedactor.redact(line).trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

export function analyseImport(input: readonly RawImportFile[], fallbackName?: string): ImportAnalysis {
  const findings: ImportFinding[] = [];
  const excluded: ExcludedFile[] = [];
  const files: Record<string, string> = {};
  let license: { path: string | null; name: string | null } | null = null;
  const push = (f: ImportFinding): void => {
    if (findings.length < MAX_FINDINGS) findings.push(f);
  };

  for (const raw of stripCommonRoot(input)) {
    const segments = raw.path.split('/');
    const lowerSegs = segments.map((s) => s.toLowerCase());
    if (segments.some((s) => s.startsWith('.')) || lowerSegs.some((s) => OS_JUNK.has(s))) {
      excluded.push({ path: raw.path, size: raw.bytes.length, reason: 'hidden' });
      push({ kind: 'skipped', severity: 'info', path: raw.path, rule: 'hidden' });
      continue;
    }
    let path = raw.path;
    if (segments.length === 1) {
      const name = segments[0] ?? '';
      if (name.toLowerCase() === 'skill.md' && name !== 'SKILL.md') {
        path = 'SKILL.md';
        push({ kind: 'moved', severity: 'info', path: raw.path, to: path, rule: 'skill_md_case' });
      } else if (LICENSE_NAME.test(name)) {
        path = `resources/${name}`;
        push({ kind: 'moved', severity: 'info', path: raw.path, to: path, rule: 'license' });
      } else if (/^readme(\.[A-Za-z0-9]{1,16})?$/i.test(name)) {
        path = `references/${name}`;
        push({ kind: 'moved', severity: 'info', path: raw.path, to: path, rule: 'readme' });
      }
    }
    const text = isUtf8Text(raw.bytes);
    if (text === null) {
      excluded.push({ path: raw.path, size: raw.bytes.length, reason: 'binary' });
      push({ kind: 'binary', severity: 'block', path: raw.path, size: raw.bytes.length });
      continue;
    }
    if (!isSkillPathV2(path)) {
      excluded.push({ path: raw.path, size: raw.bytes.length, reason: 'layout' });
      push({ kind: 'layout', severity: 'block', path: raw.path });
      continue;
    }
    if (raw.bytes.length > MAX_SKILL_FILE_BYTES_V2) {
      excluded.push({ path: raw.path, size: raw.bytes.length, reason: 'too_large' });
      push({ kind: 'file_too_large', severity: 'block', path: raw.path, size: raw.bytes.length });
      continue;
    }
    if (Object.keys(files).some((p) => p.toLowerCase() === path.toLowerCase())) {
      excluded.push({ path: raw.path, size: raw.bytes.length, reason: 'duplicate' });
      push({ kind: 'layout', severity: 'block', path: raw.path, rule: 'duplicate' });
      continue;
    }
    files[path] = text;
    if (license === null && path.startsWith('resources/') && LICENSE_NAME.test(path.slice(10))) {
      license = { path, name: licenseName(text) };
    }
  }

  const paths = Object.keys(files).sort();
  const totalBytes = paths.reduce((n, p) => n + Buffer.byteLength(files[p] ?? '', 'utf8'), 0);
  if (files['SKILL.md'] === undefined) push({ kind: 'missing_skill_md', severity: 'block' });
  if (paths.length > MAX_SKILL_FILES_V2) {
    push({ kind: 'too_many_files', severity: 'block', size: paths.length });
  }
  if (totalBytes > MAX_SKILL_TOTAL_BYTES_V2)
    push({ kind: 'total_too_large', severity: 'block', size: totalBytes });
  const layout = skillLayoutOf(
    paths.map((p) => ({ path: p, size: Buffer.byteLength(files[p] ?? '', 'utf8') })),
  );
  if (layout === 2) push({ kind: 'layout_v2', severity: 'info', size: totalBytes });

  // ADR-0006 / T-SEC-1: positions and rule ids only.
  for (const s of scanForSecrets(files)) {
    push({ kind: 'secret', severity: 'block', path: s.field, line: s.line, rule: s.rule });
  }

  const skillMd = files['SKILL.md'] ?? '';
  const skillLines = skillMd.split(/\r?\n/);
  for (const p of paths) {
    const content = files[p] ?? '';
    const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
    if (p.startsWith('scripts/') || firstLine.startsWith('#!') || SCRIPT_EXT.test(p)) {
      const mention = skillLines.findIndex((l) => l.includes(p));
      push({
        kind: 'script',
        severity: 'warn',
        path: p,
        ...(mention < 0 ? {} : { line: mention + 1 }),
        ...(p.startsWith('scripts/') ? {} : { rule: 'not_executable' }),
      });
    }
  }
  const hosts = new Set<string>();
  let activeNetwork = false;
  for (const p of paths) {
    const lines = (files[p] ?? '').split(/\r?\n/);
    const isScript = p.startsWith('scripts/') || SCRIPT_EXT.test(p);
    for (const [i, line] of lines.entries()) {
      for (const rule of RISKY_RULES) {
        if (rule.re.test(line)) {
          push({
            kind: 'risky',
            severity: 'warn',
            path: p,
            line: i + 1,
            rule: rule.id,
            excerpt: excerpt(line),
          });
        }
      }
      for (const m of line.matchAll(URL_HOST)) {
        const host = (m[1] ?? '').toLowerCase();
        if (host === '') continue;
        if (hosts.size < MAX_HOSTS) hosts.add(host);
        if (isScript || NETWORK_LINE.test(line)) activeNetwork = true;
      }
    }
  }
  if (hosts.size > 0) {
    push({ kind: 'network', severity: activeNetwork ? 'warn' : 'info', hosts: [...hosts].sort() });
  }

  const fm = readFrontmatter(skillMd);
  const name = fm.name ?? null;
  const idFromName = name === null ? null : slugSkillId(name);
  if (files['SKILL.md'] !== undefined && (name === null || !SkillId.safeParse(name).success)) {
    push({
      kind: 'name_invalid',
      severity: 'warn',
      path: 'SKILL.md',
      ...(name === null ? {} : { rule: 'format' }),
    });
  }
  const rawDescription = fm.description ?? null;
  const description =
    rawDescription === null || rawDescription.trim() === '' ? null : rawDescription.trim().slice(0, 1024);
  if (files['SKILL.md'] !== undefined && description === null) {
    push({ kind: 'no_description', severity: 'warn', path: 'SKILL.md' });
  }
  const heading = skillLines.find((l) => /^#\s+\S/.test(l));
  const title = (heading === undefined ? name : heading.replace(/^#\s+/, '').trim())?.slice(0, 120) ?? null;
  if (license === null && fm.license !== undefined && fm.license.trim() !== '') {
    license = { path: null, name: fm.license.trim().slice(0, 80) };
  }
  if (license !== null) {
    push({
      kind: 'license',
      severity: 'info',
      ...(license.path === null ? {} : { path: license.path }),
      ...(license.name === null ? {} : { rule: license.name }),
    });
  } else if (files['SKILL.md'] !== undefined) {
    push({ kind: 'no_license', severity: 'info' });
  }

  return {
    files,
    excluded,
    findings,
    blocked: findings.some((f) => f.severity === 'block'),
    suggested: {
      skillId: idFromName ?? (fallbackName === undefined ? null : slugSkillId(fallbackName)),
      title: title === null || title === '' ? null : title,
      description,
    },
    license,
    fileCount: paths.length,
    totalBytes,
    layout,
  };
}
