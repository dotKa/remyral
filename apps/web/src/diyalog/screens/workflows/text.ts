import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type Messages, messagesFor } from '@remyral/i18n';
import { asDoc, cleanDoc, type Doc } from './model';

/**
 * p13-workflows-ui: the YAML / JSON view of a definition (the editor's side panel). `yaml` (eemeli/yaml, ISC) parses
 * with the core schema only — no custom tags, no code — and a bounded alias count. Lives apart from model.ts so the
 * list screen (eager) does not pull the parser into the main bundle.
 */

export type TextFormat = 'yaml' | 'json';

export function serialize(doc: Doc, fmt: TextFormat): string {
  const clean = cleanDoc(doc);
  return fmt === 'json' ? `${JSON.stringify(clean, null, 2)}\n` : stringifyYaml(clean, { lineWidth: 0 });
}

/** Parses the panel's text (YAML is a superset of JSON, but each format is parsed as itself). */
export function parseText(
  text: string,
  fmt: TextFormat,
  t: Messages['workflows'] = messagesFor('tr').workflows,
): { doc: Doc } | { error: string } {
  let value: unknown;
  try {
    // YAML: core schema only (no custom tags), aliases bounded — the text is the user's own.
    value = fmt === 'json' ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 });
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '') : '';
    return {
      error: t.textPanel.unreadable({ format: fmt === 'json' ? 'JSON' : 'YAML', message: msg.slice(0, 160) }),
    };
  }
  return asDoc(value, t.model);
}
