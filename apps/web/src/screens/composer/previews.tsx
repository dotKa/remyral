import { type PreviewProtection } from '../../api/previews';

/**
 * p8-preview-tunnels (ADR-0032): the composer's "Open a preview when the dev server is up". Off by default. The
 * port goes to `spec.previews.autoOpen`; the worker opens the preview once something of the job listens there. The
 * project's preview settings (Project → Deploy) decide whether it happens at all — the master drops the request for
 * a project without a preview zone.
 */

export interface PreviewChoice {
  readonly enabled: boolean;
  readonly port: string;
  readonly protect: PreviewProtection;
  readonly stable: boolean;
  readonly name: string;
}

export const NO_PREVIEW: PreviewChoice = {
  enabled: false,
  port: '5173',
  protect: 'none',
  stable: false,
  name: '',
};

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

export function previewError(c: PreviewChoice): { port?: string; name?: string } {
  if (!c.enabled) return {};
  const out: { port?: string; name?: string } = {};
  const p = Number(c.port);
  if (!Number.isInteger(p) || p < 1024 || p > 65_535) out.port = 'A port between 1024 and 65535.';
  const n = c.name.trim();
  if (c.stable && n === '') out.name = 'A stable preview needs a name.';
  else if (n !== '' && !NAME.test(n)) out.name = '1–20 lower-case letters, digits and hyphens.';
  return out;
}

/** `spec.previews`, or undefined when off. */
export function previewSpec(
  c: PreviewChoice,
): { autoOpen: { port: number; protect: PreviewProtection; stable: boolean; name?: string } } | undefined {
  if (!c.enabled) return undefined;
  const name = c.name.trim();
  return {
    autoOpen: {
      port: Number(c.port),
      protect: c.protect,
      stable: c.stable,
      ...(name === '' ? {} : { name }),
    },
  };
}

/** The spec with `previews` added when the choice is on. */
export function withPreviews(
  spec: Readonly<Record<string, unknown>>,
  c: PreviewChoice,
): Readonly<Record<string, unknown>> {
  const p = previewSpec(c);
  return p === undefined ? spec : { ...spec, previews: p };
}
