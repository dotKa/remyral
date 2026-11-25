import type { Shape } from '../shape.js';
import type tr from '../tr/chatFailover.js';

/**
 * p15-chat-failover: backup machines of the chat assistant — the backup list and readiness in Settings → Chat, the
 * "Failover" tab (who answers now and why, controls, recent switches), the Sohbet header and the thread notice.
 */
export default {
  backups: {
    title: 'Backup machines',
    hint: (p: { seconds: number }) =>
      `When the primary machine is not connected or cannot answer, the chat continues on the next backup machine (the history lives on the master, any machine can continue). Once the primary has been connected for ${String(p.seconds)} s without interruption the chat goes back to it by itself.`,
    empty: 'No backup machine: if the primary goes away, the chat stops.',
    add: 'Add a backup',
    addNone: '— choose a machine —',
    position: (p: { n: number }) => `Backup ${String(p.n)}`,
    up: (p: { name: string }) => `${p.name}: move up`,
    down: (p: { name: string }) => `${p.name}: move down`,
    remove: (p: { name: string }) => `${p.name}: remove from the backups`,
    listLabel: 'Order of the backup machines',
    online: 'Connected',
    offline: 'Not connected',
    version: (p: { version: string }) => `version ${p.version}`,
    noAssistant: 'Does not run the assistant — update the machine',
    disabled: 'The assistant is turned off locally on this machine',
    engineReady: (p: { runtime: string }) => `${p.runtime} ready`,
    engineMissing: (p: { runtime: string }) => `No ${p.runtime} — update the machine or turn the runtime on`,
    engineNotReady: (p: { runtime: string; reason: string | null }) =>
      `${p.runtime} not ready${p.reason === null ? '' : `: ${p.reason}`}`,
    fallbackReady: (p: { runtime: string }) => `fallback engine ${p.runtime} ready`,
    eligible: 'Can take over',
    notEligible: 'Cannot take over now',
  },
  tab: 'Failover',
  now: {
    title: 'Now',
    sub: 'Which machine answers the chat and why. Open the tab again to reload.',
    loading: 'Loading the failover state',
    answering: (p: { machine: string }) => `Answering: ${p.machine}`,
    nobody: 'No machine can answer right now.',
    since: (p: { time: string }) => `since ${p.time}`,
    roles: { primary: 'primary', backup: (p: { n: number }) => `backup ${String(p.n)}` },
    noBackups: 'No backup machine is set — add one on the Assistant tab.',
  },
  reasons: {
    primary: 'The primary machine answers.',
    pinned: 'An administrator pinned this machine.',
    primary_offline: (p: { primary: string }) => `${p.primary} is not connected.`,
    primary_unavailable: (p: { primary: string }) => `${p.primary} cannot answer right now.`,
    primary_unstable: (p: { primary: string; time: string }) =>
      `${p.primary} reconnected; if it stays connected the chat goes back to it at ${p.time}.`,
  },
  issues: {
    offline: 'not connected',
    update_required: 'needs an update',
    disabled_on_worker: 'assistant turned off locally',
    engine_not_ready: 'runtime not ready',
    engine_limited: 'at its usage limit',
    not_found: 'no longer exists',
  },
  chain: {
    title: 'Machine order',
    caption: 'The primary and the backups, in order',
    machine: 'Machine',
    role: 'Role',
    state: 'State',
    connected: 'Connected for',
    answering: 'Answering',
    ready: 'Ready',
    fallbackEngine: (p: { runtime: string }) => `with the fallback engine (${p.runtime})`,
  },
  controls: {
    title: 'Manage',
    sub: 'Every change asks for a verification code and is written to the audit log.',
    stepUp: 'Changing the chat failover needs a fresh verification code.',
    auto: 'Automatic failover',
    autoHint:
      'Off: the chat goes only to the primary (or the pinned machine); if the primary goes away, the chat stops.',
    autoOn: 'Automatic failover is on.',
    autoOff: 'Automatic failover is off.',
    forcePrimary: 'Back to the primary',
    forcePrimaryHint:
      'Removes the pin and moves to the primary without waiting (when the primary can answer).',
    forced: 'The chat is back on the primary.',
    pinMachine: 'Machine to pin',
    pinFor: 'For',
    pin: 'Pin',
    pinned: (p: { machine: string; time: string }) => `${p.machine} is pinned until ${p.time}.`,
    unpin: 'Remove the pin',
    unpinned: 'The pin was removed.',
    durations: { m15: '15 minutes', h1: '1 hour', h4: '4 hours', h24: '24 hours' },
  },
  events: {
    title: 'Recent switches',
    empty: 'No switch yet.',
    caption: 'Recent failover switches and manual changes',
    failover: (p: { from: string; to: string }) => `${p.from} → ${p.to}: the chat moved to a backup`,
    return: (p: { to: string }) => `The chat is back on ${p.to}`,
    rerun: (p: { from: string; to: string }) =>
      `${p.from} was lost while answering; the message was answered again on ${p.to}`,
    pin: (p: { to: string; actor: string }) => `${p.actor} pinned ${p.to}`,
    unpin: (p: { actor: string }) => `${p.actor} removed the pin`,
    force_primary: (p: { to: string; actor: string }) =>
      `${p.actor} moved the chat back to the primary (${p.to})`,
    auto_off: (p: { actor: string }) => `${p.actor} turned automatic failover off`,
    auto_on: (p: { actor: string }) => `${p.actor} turned automatic failover on`,
    someone: 'an administrator',
    unknown: 'unknown machine',
  },
  header: {
    backup: (p: { why: string }) => `backup — ${p.why}`,
    pinned: 'pinned',
    offline: (p: { primary: string }) => `${p.primary} not connected`,
    unavailable: (p: { primary: string }) => `${p.primary} cannot answer`,
    unstable: (p: { primary: string }) => `${p.primary} just reconnected`,
  },
  notice: {
    primary_offline: (p: { from: string; to: string }) =>
      `${p.from} is not connected; the answer comes from ${p.to}.`,
    primary_unavailable: (p: { from: string; to: string }) =>
      `${p.from} cannot answer right now; the answer comes from ${p.to}.`,
    primary_unstable: (p: { from: string; to: string }) =>
      `${p.from} has just reconnected; ${p.to} keeps answering until it is stable.`,
    pinned: (p: { to: string }) => `The answer comes from ${p.to} (pinned by an administrator).`,
    returned: (p: { to: string }) => `The answer comes from ${p.to} again.`,
    rerun: (p: { from: string; to: string }) =>
      `${p.from} was lost while answering; the answer comes from ${p.to}.`,
    restart: 'The master restarted while answering; your message is answered again.',
  },
} satisfies Shape<typeof tr>;
