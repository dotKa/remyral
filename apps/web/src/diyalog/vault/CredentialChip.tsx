import type { TokenSegment } from '@remyral/protocol/chat-secrets';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';

/**
 * p15-chat-vault: the chips of a message's `{{credential:NAME}}` / `{{secret:…}}` tokens. A credential chip shows the
 * name, the kind and how many machines hold it (from `meta.credentials`, resolved by the master at send time for the
 * sender) and links to Settings → Credentials; a secret placeholder says it was not sent. Labels are React text only.
 */

export interface MetaCredential {
  readonly name: string;
  readonly id: string | null;
  readonly kind: string | null;
  readonly allowedHosts: readonly string[] | null;
  readonly machines: number;
}

/** `meta.credentials` of a user message (malformed entries skipped). */
export function metaCredentials(meta: Record<string, unknown> | null): MetaCredential[] {
  const raw = meta?.credentials;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x: unknown) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    if (typeof o.name !== 'string') return [];
    return [
      {
        name: o.name,
        id: typeof o.id === 'string' ? o.id : null,
        kind: typeof o.kind === 'string' ? o.kind : null,
        allowedHosts: Array.isArray(o.allowedHosts)
          ? o.allowedHosts.filter((h): h is string => typeof h === 'string')
          : null,
        machines: typeof o.machines === 'number' ? o.machines : 0,
      },
    ];
  });
}

export function TokenChip(props: {
  readonly seg: Exclude<TokenSegment, { kind: 'text' }>;
  readonly credentials: readonly MetaCredential[];
}): ReactNode {
  const t = useT().chatVault.chip;
  const providers = useT().chatVault.providers as Readonly<Record<string, string>>;
  const { seg } = props;
  if (seg.kind === 'secret') {
    const label =
      seg.handle === 'removed'
        ? t.removed
        : `${t.pasted}${seg.hint !== null && providers[seg.hint] !== undefined ? ` · ${providers[seg.hint] ?? ''}` : ''}`;
    return (
      <span
        className="dy-mention"
        data-mention="secret"
        data-testid="secret-chip"
        role="img"
        aria-label={label}
      >
        <DyIcon name="key" className="dy-mention-icon" />
        <span className="dy-mention-label">{label}</span>
      </span>
    );
  }
  const c = props.credentials.find((x) => x.name === seg.name);
  const facts =
    c === undefined || c.id === null
      ? t.unknown
      : [c.kind, c.allowedHosts?.join(', '), t.machines({ n: c.machines })].filter(Boolean).join(' · ');
  const body = (
    <>
      <DyIcon name="key" className="dy-mention-icon" />
      <span className="dy-mention-label">{`@${seg.name}`}</span>
      {c?.kind == null ? null : <span className="text-[0.85em] font-normal text-dy-muted">{c.kind}</span>}
    </>
  );
  if (c?.id == null)
    return (
      <span
        className="dy-mention"
        data-mention="credential"
        data-missing=""
        data-testid="credential-chip"
        role="img"
        title={`${t.credential}: ${seg.name} — ${facts}`}
        aria-label={`${t.credential}: ${seg.name} (${facts})`}
      >
        {body}
      </span>
    );
  return (
    <Link
      to={`/settings/credentials#credential-${c.id}`}
      className="dy-mention"
      data-mention="credential"
      data-testid="credential-chip"
      title={`${t.credential}: ${seg.name} — ${facts}`}
      aria-label={`${t.credential}: ${seg.name} (${facts}) — ${t.open}`}
    >
      {body}
    </Link>
  );
}
