import { type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ChatMessage } from '../../api/chat';
import { useSharedT } from '../../i18n/scope';

/**
 * Parts of the chat message rendering (p5-chat-ux) the Diyalog Sohbet rows use: the tool name of a tool call, the
 * "Show in Outputs" link and the watch links of a message.
 */

/** The tool name of a transcript line (`meta.name`, else the text before the first colon). */
export function toolName(m: ChatMessage): string {
  if (typeof m.meta?.name === 'string') return m.meta.name;
  const i = m.content.indexOf(':');
  return i > 0 && i <= 64 ? m.content.slice(0, i) : 'tool';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** p6-outputs: a successful "deploy when done" note links to the site on the Outputs screen. */
export function OutputsLink(props: { readonly m: ChatMessage }): ReactNode {
  // p14-i18n-shell: rendered inside Diyalog Sohbet rows too (English in the classic console).
  const t = useSharedT().shared.chat;
  const meta = props.m.meta;
  const jobId = meta?.jobId;
  if (meta?.notice !== 'deploy-on-success' || meta.state !== 'succeeded') return null;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return null;
  return (
    <Link
      to={`/outputs?tab=site&job=${jobId}`}
      className="text-meta text-accent underline"
      data-testid="chat-outputs-link"
    >
      {t.showInOutputs}
    </Link>
  );
}

const LOCAL_LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

/** p6-chat-notify: a fired watch's console links (job, approval, Outputs …) as in-app links. */
export function WatchLinks(props: { readonly m: ChatMessage }): ReactNode {
  const meta = props.m.meta;
  if (meta?.notice !== 'chat-watch' || !Array.isArray(meta.links)) return null;
  const links = (meta.links as unknown[])
    .filter(
      (l): l is { label: string; href: string } =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as { label?: unknown }).label === 'string' &&
        typeof (l as { href?: unknown }).href === 'string' &&
        LOCAL_LINK.test((l as { href: string }).href),
    )
    .slice(0, 4);
  if (links.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-meta" data-testid="chat-watch-links">
      {links.map((l) => (
        <Link key={l.href} to={l.href} className="text-accent underline">
          {l.label.slice(0, 80)}
        </Link>
      ))}
    </p>
  );
}
