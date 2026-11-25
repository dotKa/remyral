import type { ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import type { Messages } from '@remyral/i18n';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { useUsername } from '../../lib/userDirectory';

/**
 * p12-diyalog-final: the classic `Actor` in the Diyalog language — a person, not a UUID. The same rules: the signed-in
 * user directly ("Sen" with `you`), other users through the cached /users directory (owner / admin only, as classic),
 * a plain Turkish word for system actors, and for an unknown id (or a viewer who cannot read /users) the first eight
 * characters in mono with the full id as the tooltip.
 */

/** The actor shapes the master returns (the classic `ActorRef`): `{ type, id }`, a bare user id, or a username. */
export type ActorRef =
  | { readonly type: string; readonly id: string | null; readonly username?: string | null }
  | string
  | null
  | undefined;

const SYSTEM_TYPES = [
  'system',
  'worker',
  'scheduler',
  'schedule',
  'integrator',
  'chat',
  'automation',
] as const;

function systemLabel(t: Messages['shared']['actor'], type: string): string | undefined {
  const k = SYSTEM_TYPES.find((x) => x === type);
  return k === undefined ? undefined : t[k];
}

const short = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

export function DyActor(props: {
  readonly actor: ActorRef;
  readonly you?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const { state } = useAuth();
  const t = useT().shared.actor;
  const a = props.actor;
  const isObj = typeof a === 'object' && a !== null;
  const type = isObj ? a.type : 'user';
  const id = isObj ? a.id : (a ?? null);
  const given = isObj ? (a.username ?? null) : null;
  const me = state.kind === 'signedIn' ? state.user : null;
  const isUser = type === 'user';
  const canRead = me !== null && (me.role === 'owner' || me.role === 'admin');
  const looked = useUsername(isUser && given === null && id !== me?.id ? id : null, canRead);

  if (!isUser) {
    const label = systemLabel(t, type) ?? type.charAt(0).toLocaleUpperCase('tr-TR') + type.slice(1);
    return (
      <span className={props.className} title={id ?? undefined}>
        {id && type !== 'system' ? `${label} ${short(id)}` : label}
      </span>
    );
  }
  if (id === null || id === '') return <span className={props.className}>{t.unknown}</span>;
  if (me !== null && id === me.id)
    return <span className={props.className}>{props.you === true ? t.you : me.username}</span>;
  const name = given ?? looked;
  if (name !== undefined) return <span className={props.className}>{name}</span>;
  return (
    <span className={cx('font-dy-mono text-[0.78125rem]', props.className)} title={id}>
      {short(id)}
    </span>
  );
}
