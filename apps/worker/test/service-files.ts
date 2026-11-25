import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Shipped service definitions under infra/worker/ (tests read the real files). */
export const INFRA = fileURLToPath(new URL('../../../infra/worker/', import.meta.url));

export function readInfra(relative: string): string {
  return readFileSync(`${INFRA}${relative}`, 'utf8');
}

/** systemd unit → section → key → values (repeated keys accumulate). Comments/blank lines skipped. */
export function parseUnit(text: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || current === null) throw new Error(`unparseable unit line: ${line}`);
    const key = line.slice(0, eq);
    current.set(key, [...(current.get(key) ?? []), line.slice(eq + 1)]);
  }
  return sections;
}

export function unitValue(
  unit: Map<string, Map<string, string[]>>,
  section: string,
  key: string,
): string | undefined {
  return unit.get(section)?.get(key)?.at(-1);
}

/** Signals systemd treats as a clean exit for `Restart=on-failure` (systemd.service(5)). */
const SYSTEMD_CLEAN_SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGPIPE']);

/**
 * What systemd does when the main process exits, per the unit's restart settings
 * (Restart=, RestartPreventExitStatus=, SuccessExitStatus=). Only the subset our unit uses.
 */
export function systemdWouldRestart(
  unit: Map<string, Map<string, string[]>>,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): boolean {
  const restart = unitValue(unit, 'Service', 'Restart') ?? 'no';
  const prevent = (unitValue(unit, 'Service', 'RestartPreventExitStatus') ?? '').split(/\s+/).filter(Boolean);
  if (exit.code !== null && prevent.includes(String(exit.code))) return false;
  if (exit.signal !== null && prevent.includes(exit.signal)) return false;
  const clean = exit.signal === null ? exit.code === 0 : SYSTEMD_CLEAN_SIGNALS.has(exit.signal);
  switch (restart) {
    case 'always':
      return true;
    case 'on-failure':
      return !clean;
    case 'no':
      return false;
    default:
      throw new Error(`Restart=${restart} not modelled`);
  }
}

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

/** Minimal XML property-list parser (dict/array/string/integer/true/false) for the shipped plist. */
export function parsePlist(xml: string): PlistValue {
  const tokens = xml
    .replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '')
    .match(/<[^>]+>|[^<]+/g)
    ?.map((t) => t.trim())
    .filter((t) => t !== '');
  if (tokens === undefined) throw new Error('empty plist');
  let i = 0;
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  const text = (close: string) => {
    let value = '';
    if (tokens[i] !== close) value = unescape(tokens[i++] ?? '');
    if (tokens[i++] !== close) throw new Error(`expected ${close}`);
    return value;
  };
  const value = (): PlistValue => {
    const tag = tokens[i++];
    switch (tag) {
      case '<string>':
        return text('</string>');
      case '<integer>':
        return Number(text('</integer>'));
      case '<true/>':
        return true;
      case '<false/>':
        return false;
      case '<array>': {
        const out: PlistValue[] = [];
        while (tokens[i] !== '</array>') out.push(value());
        i++;
        return out;
      }
      case '<dict>': {
        const out: Record<string, PlistValue> = {};
        while (tokens[i] !== '</dict>') {
          if (tokens[i++] !== '<key>') throw new Error(`expected <key> at token ${String(i)}`);
          const key = text('</key>');
          out[key] = value();
        }
        i++;
        return out;
      }
      default:
        throw new Error(`unsupported plist token ${String(tag)}`);
    }
  };
  if (tokens[i++] !== '<plist version="1.0">') throw new Error('not a plist');
  const root = value();
  if (tokens[i] !== '</plist>') throw new Error('trailing content');
  return root;
}

/**
 * launchd with `KeepAlive = { SuccessfulExit: false }`: restart unless the job exited with
 * status 0 (launchd.plist(5)); a signal is not a successful exit.
 */
export function launchdWouldRestart(
  plist: Record<string, PlistValue>,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): boolean {
  const keepAlive = plist.KeepAlive;
  if (keepAlive === true) return true;
  if (typeof keepAlive !== 'object' || Array.isArray(keepAlive)) return false;
  const successfulExit = keepAlive.SuccessfulExit;
  if (typeof successfulExit !== 'boolean') throw new Error('KeepAlive form not modelled');
  const succeeded = exit.signal === null && exit.code === 0;
  return successfulExit ? succeeded : !succeeded;
}
