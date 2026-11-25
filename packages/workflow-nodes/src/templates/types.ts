/**
 * p14-workflow-engine 14.5 (ADR-0055): ready-made workflow templates — pure data. A template declares the placeholders
 * the gallery wizard asks for (hosts, vault credentials, addresses, schedule, runtime) and builds a v2 definition from
 * the filled values. User-facing text (name, description, node labels, approval / notification texts) comes from the
 * i18n catalog (`@remyral/i18n` → `workflowTemplates.items[<id>]`) through {@link TemplateText}; the master passes it.
 */

export type TemplateCategory = 'marketing' | 'content' | 'video';

export type PlaceholderKind =
  /** `https://host[:port]` — the static origin of an HTTP node (the catalog's `HttpOrigin`). */
  | 'origin'
  /** A request path starting with `/` (static part of an HTTP node). */
  | 'path'
  /** A vault credential id (`http-auth` / `smtp`, bound to the host of `hostFrom`). */
  | 'credential'
  | 'email'
  /** Short plain text (≤ 200 characters, one line, no `{{`). */
  | 'text'
  /** Five-field cron, UTC. */
  | 'cron'
  /** One of the e-mail node's SMTP provider presets. */
  | 'smtpProvider'
  /** One of the four runtimes. */
  | 'runtime'
  /** An integer between `min` and `max`. */
  | 'number'
  /** One of `options`. */
  | 'choice';

export interface PlaceholderSpec {
  readonly key: string;
  readonly kind: PlaceholderKind;
  readonly required: boolean;
  readonly default?: string;
  readonly credentialKind?: 'http-auth' | 'smtp';
  /** For a credential: the placeholder (origin or SMTP provider) whose host the credential must be bound to. */
  readonly hostFrom?: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/** The localized text a template's definition carries (from the i18n catalog). */
export interface TemplateText {
  /** The workflow name the user chose (`WORKFLOW_NAME_PATTERN`). */
  readonly name: string;
  readonly description: string;
  /** A node's label, or undefined. */
  readonly label: (nodeId: string) => string | undefined;
  /** A content string of the template (approval titles, notification titles, report headings). */
  readonly text: (key: string) => string;
}

/** Filled values: every placeholder key present (defaults applied; optional ones may be ''). */
export type TemplateValues = Readonly<Record<string, string>>;

export interface WorkflowTemplate {
  readonly id: string;
  readonly category: TemplateCategory;
  readonly placeholders: readonly PlaceholderSpec[];
  /** The content-string keys `build` asks `text()` for (the i18n catalog must define each). */
  readonly textKeys: readonly string[];
  readonly build: (values: TemplateValues, text: TemplateText) => Record<string, unknown>;
}
