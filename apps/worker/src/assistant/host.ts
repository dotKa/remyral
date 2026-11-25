import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASSISTANT_DEFAULT_TIMEOUTS,
  ASSISTANT_SYSTEM_PROMPT,
  assistantUsageLimit,
  PROVIDER_USAGE_LIMIT,
  type AssistantEngine,
  type AssistantSession,
  type AssistantToolCallResult,
  type AssistantTurnAttachment,
  type ProcessConfiner,
  type SecretEnv,
} from '@remyral/agent-adapters';
import type { Logger, Redactor } from '@remyral/observability';
import type { LoginGateHold, LoginGatePort } from '../runtimes/login-gate.js';
import { loginStoreOf } from '../sandbox/login-stores.js';
import type { RuntimeUsageCollector } from '../runtimes/usage.js';
import {
  ASSISTANT_TOOL_NAMES,
  type AssistantAttachmentRef,
  attachmentMagicMatches,
  type AssistantCancelPayload,
  type AssistantReport,
  type AssistantResumePayload,
  type AssistantRuntime,
  type AssistantToolName,
  type AssistantToolResultPayload,
  type AssistantTurnPayload,
  type AssistantUpdatePayload,
  assistantTurnWindow,
  type LeaseKey,
  MAX_ASSISTANT_DELTA,
  MAX_ASSISTANT_TURN_TTL_MS,
  verifyAssistantTurn,
} from '@remyral/protocol';

/**
 * Worker side of the ops chat (p5-ops-chat, ADR-0018, docs/design/p5-ops-chat.md §3): runs assistant
 * sessions — one per chat thread, created on demand and closed when idle — and relays their tool calls to
 * the master. It never executes a tool, never reads a repository or workspace, and never trusts a turn
 * beyond its schema:
 *
 *  - the local opt-out (`assistant.disabled` in the root-owned local config) refuses every turn;
 *  - every ASSISTANT_TURN must carry a valid master lease-key signature (pinned `masterLeaseKeys`, else the
 *    session's keys) bound to this worker, the turn id, a ≤ 5-minute window and the content; replays are
 *    refused (turn ids are remembered for the window);
 *  - the engine runs with the runtime's configured auth on this worker (local login or a vault credential,
 *    exactly like jobs), in an empty private scratch directory;
 *  - everything sent back (deltas, the answer, errors) passes the daemon redactor (known secret values and
 *    secret patterns).
 */

export interface AssistantAuth {
  readonly authMode: 'secret-ref' | 'local-login';
  readonly secretEnv: SecretEnv;
  /**
   * p13-runtime-accounts: the runtime account the session runs with (absent = `default`), and for an added
   * subscription account its config dir, folder and login store.
   */
  readonly account?: string;
  readonly loginDir?: string;
  readonly loginFolder?: string;
  readonly store?: string;
  /** Releases the secrets' redaction registration (when the session closes). */
  release(): void;
}

/** The assistant sandbox profile of one session (p5-ops-chat-next, apps/worker/src/assistant/sandbox.ts). */
export interface AssistantSessionSandbox {
  readonly confiner?: ProcessConfiner;
  /** Non-secret child environment the profile needs (HOME/TMPDIR inside the session dir …). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface AssistantHostOptions {
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly engines: Partial<Record<AssistantRuntime, AssistantEngine>>;
  /** Trusted master keys: pinned `masterLeaseKeys`, else the current session's keys. */
  readonly keySource: () => { readonly keys: readonly LeaseKey[]; readonly pinned: boolean };
  /** Local opt-out (root-owned config): no assistant on this machine. */
  readonly disabled: boolean;
  /** `<dataDir>/assistant`: private scratch directories of the sessions. */
  readonly scratchRoot: string;
  /** Whether the runtime may be used here (enabled in the configuration, auth configured). */
  readonly runtimeAllowed: (runtime: AssistantRuntime) => { ok: true } | { ok: false; reason: string };
  /**
   * Resolves the runtime's auth exactly like a job's environment (throws with a reason). p13-runtime-accounts:
   * `account` = the turn's runtime account (absent = the configured auth).
   */
  readonly auth: (runtime: AssistantRuntime, account?: string) => Promise<AssistantAuth>;
  /**
   * The assistant sandbox profile for a new session (throws with a reason when the profile is required but
   * unavailable). `sessionDir` holds the session's `work` (cwd) and `state` directories; nothing else is
   * writable for the runtime. Absent: host-native (tests, development).
   */
  readonly sandbox?: (input: {
    readonly runtime: AssistantRuntime;
    readonly authMode: 'secret-ref' | 'local-login';
    readonly sessionDir: string;
    /** p13-runtime-accounts: an added subscription account's folder (its login store, writable). */
    readonly loginFolder?: string;
  }) => Promise<AssistantSessionSandbox>;
  /** Readiness of the sandbox profile, merged into the engines' readiness (`ready: false` refuses turns). */
  readonly sandboxReady?: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** CAPABILITIES.assistant.sandbox (what the profile enforces on this machine). */
  readonly sandboxReport?: () => AssistantReport['sandbox'];
  readonly clock?: () => Date;
  readonly maxSessions?: number;
  /** Sessions without a turn for this long are closed (default 15 min). */
  readonly idleMs?: number;
  /** A tool call without an answer from the master fails after this (default 60 s). */
  readonly toolTimeoutMs?: number;
  readonly timeouts?: Partial<typeof ASSISTANT_DEFAULT_TIMEOUTS>;
  /** Deltas are coalesced for this long before they are sent (default 60 ms). */
  readonly flushMs?: number;
  /**
   * p8-chat-attachments-mentions: pulls the bytes of one attachment of a running turn from the master
   * (ASSISTANT_ATTACHMENT_REQUEST / _DATA). Absent: turns with attachments fail (`attachment_unavailable`).
   */
  readonly fetchAttachment?: (
    turnId: string,
    ref: AssistantAttachmentRef,
    signal: AbortSignal,
  ) => Promise<Buffer>;
  /**
   * p10-claude-login-health: the worker's per-login-store gate, shared with job attempts. A subscription-login
   * session holds it from its start (or a turn sent to a running one) until the first streamed text or the end of
   * the turn, so it never refreshes the OAuth token at the same moment as a starting job. Absent: no gate.
   */
  readonly loginGate?: LoginGatePort;
  /**
   * p10-claude-login-health: a subscription-login turn completed — evidence that the login works (the daemon
   * clears an expiry flag of the runtime, like after a successful job).
   */
  readonly onLoginUsable?: (runtime: AssistantRuntime, account?: string) => void;
  /** p11-limit-visibility: usage-limit windows the assistant runtime reports (observation only). */
  readonly runtimeUsage?: Pick<RuntimeUsageCollector, 'observer'> &
    Partial<Pick<RuntimeUsageCollector, 'afterRun'>>;
  /**
   * p17-chat-reconnect: how long a turn keeps running after the master connection dropped, waiting for
   * ASSISTANT_RESUME (default 90 s — the master's grace is 45 s plus the reconnect). 0: abort at once (before
   * p17-chat-reconnect).
   */
  readonly resumeHoldMs?: number;
  /**
   * p17-chat-reconnect: how long a finished turn's updates stay available for a resume (default 60 s: a stale socket
   * swallows what was written in the last ping + pong window).
   */
  readonly retainMs?: number;
  /** p17-chat-reconnect: bytes of updates kept per turn for a resume (default 2 MiB; older ones are dropped). */
  readonly maxLogBytes?: number;
}

interface Live {
  readonly key: string;
  readonly runtime: AssistantRuntime;
  readonly model: string | undefined;
  readonly session: AssistantSession;
  readonly auth: AssistantAuth;
  readonly scratch: string;
  lastUsed: number;
  turn: RunningTurn | null;
}

interface RunningTurn {
  readonly turnId: string;
  readonly abort: AbortController;
  seq: number;
  readonly calls: Map<string, (r: AssistantToolCallResult) => void>;
  /**
   * p17-chat-reconnect: every update of the turn in seq order (bounded by bytes; `firstSeq` is the oldest kept), so
   * the ones a dropped connection swallowed can be sent again after ASSISTANT_RESUME.
   */
  readonly log: AssistantUpdatePayload[];
  logBytes: number;
  firstSeq: number;
  /** p17-chat-reconnect: the connection dropped (ms); updates are kept, not sent, until the master resumes the turn. */
  heldAt: number | null;
  /** p17-chat-reconnect: the master gave the turn up (or it can no longer be resumed): nothing more is sent. */
  dropped: boolean;
}

function newTurn(turnId: string): RunningTurn {
  return {
    turnId,
    abort: new AbortController(),
    seq: 0,
    calls: new Map(),
    log: [],
    logBytes: 0,
    firstSeq: 1,
    heldAt: null,
    dropped: false,
  };
}

type Send = (payload: AssistantUpdatePayload) => Promise<void>;
/** An update before the host numbers it (distributive over the union). */
type Update = AssistantUpdatePayload extends infer U
  ? U extends AssistantUpdatePayload
    ? Omit<U, 'seq' | 'turnId'>
    : never
  : never;

export class AssistantHost {
  readonly #o: AssistantHostOptions;
  readonly #log: Logger;
  readonly #sessions = new Map<string, Live>();
  /** turnId → expiry (ms): replay protection for the validity window. */
  readonly #seen = new Map<string, number>();
  readonly #turns = new Map<string, { live: Live | null; turn: RunningTurn }>();
  /** Session keys with a turn accepted or running (one turn at a time per thread), and that run's end. */
  readonly #busy = new Map<string, { readonly turnId: string; done: Promise<void> }>();
  /** p17-chat-reconnect: finished turns whose updates may still be asked for (turnId → turn, kept until `until`). */
  readonly #finished = new Map<string, { readonly turn: RunningTurn; until: number }>();
  #send: Send | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: AssistantHostOptions) {
    this.#o = options;
    this.#log = options.logger.child({ component: 'assistant' });
    const idle = options.idleMs ?? 15 * 60_000;
    this.#sweeper = setInterval(
      () => {
        void this.#sweep(idle);
      },
      Math.max(1_000, Math.min(60_000, Math.floor(idle / 4))),
    );
    this.#sweeper.unref();
  }

  /** Where ASSISTANT_UPDATE goes (the daemon's control channel). */
  attach(send: Send): void {
    this.#send = send;
  }

  get activeSessions(): number {
    return this.#sessions.size;
  }

  get maxSessions(): number {
    return this.#o.maxSessions ?? 8;
  }

  #now(): Date {
    return this.#o.clock?.() ?? new Date();
  }

  async report(): Promise<AssistantReport> {
    const engines: AssistantReport['engines'] = [];
    for (const [runtime, engine] of Object.entries(this.#o.engines) as [
      AssistantRuntime,
      AssistantEngine,
    ][]) {
      const allowed = this.#o.runtimeAllowed(runtime);
      if (!allowed.ok) {
        engines.push({ runtime, ready: false, reason: allowed.reason.slice(0, 300) });
        continue;
      }
      const sandbox = this.#o.sandboxReady?.() ?? { ok: true as const };
      if (!sandbox.ok) {
        engines.push({ runtime, ready: false, reason: sandbox.reason.slice(0, 300) });
        continue;
      }
      const r = await engine.ready().catch(() => ({ ready: false, reason: 'readiness check failed' }));
      engines.push({
        runtime,
        ready: r.ready,
        ...(r.reason === undefined ? {} : { reason: r.reason.slice(0, 300) }),
        input: engineInput(engine),
      });
    }
    const sandbox = this.#o.sandboxReport?.();
    return {
      disabled: this.#o.disabled,
      engines,
      maxSessions: this.maxSessions,
      ...(sandbox === undefined ? {} : { sandbox }),
    };
  }

  get #resumeHoldMs(): number {
    return this.#o.resumeHoldMs ?? 90_000;
  }

  /**
   * Numbers the update, keeps it in the turn's log (p17-chat-reconnect) and sends it unless the connection dropped.
   * The send is started synchronously, so the transport queue keeps the turn's seq order.
   */
  async #emit(turn: RunningTurn, update: Update): Promise<void> {
    turn.seq += 1;
    const payload: AssistantUpdatePayload = { ...update, turnId: turn.turnId, seq: turn.seq };
    if (this.#resumeHoldMs > 0) this.#keep(turn, payload);
    if (turn.heldAt !== null || turn.dropped) return;
    await this.#deliver(payload);
  }

  async #deliver(payload: AssistantUpdatePayload): Promise<void> {
    try {
      await (this.#send ?? (() => Promise.reject(new Error('not attached'))))(payload);
    } catch (err) {
      this.#log.debug('ASSISTANT_UPDATE not sent', { turnId: payload.turnId, kind: payload.kind, err });
    }
  }

  #keep(turn: RunningTurn, payload: AssistantUpdatePayload): void {
    const bytes = JSON.stringify(payload).length;
    turn.log.push(payload);
    turn.logBytes += bytes;
    const max = this.#o.maxLogBytes ?? 2 * 1024 * 1024;
    while (turn.logBytes > max && turn.log.length > 1) {
      const old = turn.log.shift();
      if (old === undefined) break;
      turn.logBytes -= JSON.stringify(old).length;
      turn.firstSeq = old.seq + 1;
    }
  }

  async #refuse(turnId: string, reason: Extract<AssistantUpdatePayload, { kind: 'refused' }>['reason']) {
    this.#log.warn('assistant turn refused', { turnId, reason });
    const t = newTurn(turnId);
    await this.#emit(t, { kind: 'refused', reason });
  }

  /** ASSISTANT_TURN: verified, then run in the background (never blocks the message queue). */
  async onTurn(workerId: string | null, p: AssistantTurnPayload): Promise<void> {
    if (this.#stopped) return;
    if (this.#o.disabled) return this.#refuse(p.turnId, 'disabled');
    const now = this.#now();
    if (assistantTurnWindow(p, now) !== 'ok') return this.#refuse(p.turnId, 'expired');
    const { keys } = this.#o.keySource();
    const { signature, ...turn } = p;
    const verdict =
      workerId === null || keys.length === 0
        ? 'missing'
        : verifyAssistantTurn({ workerId, turn }, signature, keys);
    if (verdict !== 'ok') return this.#refuse(p.turnId, verdict === 'missing' ? 'unsigned' : 'bad_signature');
    for (const [id, exp] of this.#seen) if (exp < now.getTime()) this.#seen.delete(id);
    if (this.#seen.has(p.turnId)) return this.#refuse(p.turnId, 'replayed');
    this.#seen.set(p.turnId, Date.parse(p.expiresAt) + 2 * MAX_ASSISTANT_TURN_TTL_MS);
    const engine = this.#o.engines[p.runtime];
    if (engine === undefined || !this.#o.runtimeAllowed(p.runtime).ok) {
      return this.#refuse(p.turnId, 'runtime_unavailable');
    }
    const previous = this.#busy.get(p.sessionKey);
    if (previous !== undefined) {
      // p17-chat-reconnect: a turn still held after a reconnect was given up by the master (it sends a thread's next
      // turn only when none runs there): it ends now and the new turn takes the session.
      const held = this.#turns.get(previous.turnId)?.turn;
      if (held === undefined || held.heldAt === null) return this.#refuse(p.turnId, 'busy');
      this.#log.info('assistant turn held after a reconnect replaced by a new turn', {
        turnId: previous.turnId,
        next: p.turnId,
      });
      held.dropped = true;
      held.abort.abort();
      await previous.done;
      if (this.#busy.has(p.sessionKey)) return this.#refuse(p.turnId, 'busy');
    }
    const existing = this.#sessions.get(p.sessionKey) ?? null;
    const entry: { readonly turnId: string; done: Promise<void> } = {
      turnId: p.turnId,
      done: Promise.resolve(),
    };
    this.#busy.set(p.sessionKey, entry);
    entry.done = this.#run(engine, p, existing)
      .catch((err: unknown) => {
        this.#log.error('assistant turn crashed', { turnId: p.turnId, err });
      })
      .finally(() => {
        if (this.#busy.get(p.sessionKey) === entry) this.#busy.delete(p.sessionKey);
      });
  }

  async #run(engine: AssistantEngine, p: AssistantTurnPayload, existing: Live | null): Promise<void> {
    const turn = newTurn(p.turnId);
    this.#turns.set(p.turnId, { live: existing, turn });
    let live = existing;
    const login: { hold: LoginGateHold | null } = { hold: null };
    const takeLogin = async (authMode: AssistantAuth['authMode']): Promise<void> => {
      if (authMode !== 'local-login' || this.#o.loginGate === undefined || login.hold !== null) return;
      login.hold = await this.#o.loginGate.acquire(
        live?.auth.store ?? loginStoreOf(p.runtime),
        `assistant:${p.sessionKey.slice(0, 40)}`,
        turn.abort.signal,
      );
    };
    try {
      // p8-chat-attachments-mentions: the attachments' bytes first (verified against the signed refs); a turn whose
      // attachments cannot be read does not run (the model must not answer about an image it never saw).
      const prepared = await this.#attachments(engine, p, turn.abort.signal);
      if (!prepared.ok) {
        await this.#emit(turn, {
          kind: 'failed',
          reason: turn.abort.signal.aborted ? 'cancelled' : 'attachment_unavailable',
          detail: prepared.detail,
        });
        return;
      }
      // A session started for another model (Settings → Chat changed) is replaced.
      // p13-runtime-accounts: and a session of another runtime account (Settings → Chat account / fallback account).
      if (
        live !== null &&
        (!live.session.alive ||
          live.model !== p.model ||
          !sameRuntime(live, p) ||
          (live.auth.account ?? 'default') !== (p.account ?? 'default'))
      ) {
        await this.#close(live);
        live = null;
      }
      let fresh = false;
      if (live === null) {
        if (this.#sessions.size >= this.maxSessions && !(await this.#evictOne())) {
          await this.#emit(turn, { kind: 'refused', reason: 'too_many_sessions' });
          return;
        }
        let auth: AssistantAuth;
        try {
          auth = await this.#o.auth(p.runtime, p.account);
        } catch (err) {
          await this.#emit(turn, {
            kind: 'failed',
            reason: 'runtime_not_configured',
            detail: this.#o.redactor
              .redact(err instanceof Error ? err.message : 'no credential for the runtime')
              .slice(0, 500),
          });
          return;
        }
        if (auth.authMode === 'local-login' && this.#o.loginGate !== undefined && login.hold === null) {
          login.hold = await this.#o.loginGate.acquire(
            auth.store ?? loginStoreOf(p.runtime),
            `assistant:${p.sessionKey.slice(0, 40)}`,
            turn.abort.signal,
          );
        }
        await mkdir(this.#o.scratchRoot, { recursive: true, mode: 0o700 });
        // <scratchRoot>/s-XXXX/{work,state}: the runtime's cwd (empty) and its private config/state.
        const scratch = await mkdtemp(join(this.#o.scratchRoot, 's-'));
        const work = join(scratch, 'work');
        const stateDir = join(scratch, 'state');
        const t = { ...ASSISTANT_DEFAULT_TIMEOUTS, ...this.#o.timeouts };
        const holder: { live: Live | null } = { live: null };
        let session: AssistantSession;
        try {
          await mkdir(work, { mode: 0o700 });
          await mkdir(stateDir, { mode: 0o700 });
          const sandbox =
            this.#o.sandbox === undefined
              ? {}
              : await this.#o.sandbox({
                  runtime: p.runtime,
                  authMode: auth.authMode,
                  sessionDir: scratch,
                  ...(auth.loginFolder === undefined ? {} : { loginFolder: auth.loginFolder }),
                });
          session = await engine.start({
            ...(p.model === undefined ? {} : { model: p.model }),
            cwd: work,
            stateDir,
            ...(sandbox.confiner === undefined ? {} : { confiner: sandbox.confiner }),
            ...(sandbox.env === undefined ? {} : { env: sandbox.env }),
            authMode: auth.authMode,
            ...(auth.loginDir === undefined ? {} : { loginDir: auth.loginDir }),
            secretEnv: auth.secretEnv,
            ...(this.#o.runtimeUsage === undefined
              ? {}
              : {
                  onUsage: this.#o.runtimeUsage.observer(
                    p.runtime,
                    auth.authMode === 'local-login' ? 'subscription' : 'api_key',
                    'assistant',
                    auth.account,
                  ),
                }),
            systemPrompt: ASSISTANT_SYSTEM_PROMPT,
            timeouts: t,
            tools: {
              call: (tool, input, callId, signal) => this.#toolCall(holder, tool, input, callId, signal),
            },
          });
        } catch (err) {
          auth.release();
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
          await this.#emit(turn, {
            kind: 'failed',
            reason: 'runtime_start_failed',
            detail: this.#o.redactor
              .redact(err instanceof Error ? err.message : 'start failed')
              .slice(0, 500),
          });
          return;
        }
        live = {
          key: p.sessionKey,
          runtime: p.runtime,
          model: p.model,
          session,
          auth,
          scratch,
          lastUsed: Date.now(),
          turn: null,
        };
        holder.live = live;
        this.#sessions.set(p.sessionKey, live);
        fresh = true;
      }
      await takeLogin(live.auth.authMode);
      live.turn = turn;
      live.lastUsed = Date.now();
      this.#turns.set(p.turnId, { live, turn });
      await this.#emit(turn, { kind: 'accepted', fresh });
      const result = await this.#runTurn(live, turn, p, fresh, prepared, () => {
        login.hold?.release();
      });
      const r = this.#o.redactor;
      if (result.outcome === 'done') {
        if (live.auth.authMode === 'local-login') this.#o.onLoginUsable?.(p.runtime, live.auth.account);
        await this.#emit(turn, { kind: 'done', text: r.redact(result.text), usage: result.usage });
      } else {
        // p11-usage-limit-fallback: a usage limit of any engine is reported as such, with its reset, so the master
        // can say when the assistant works again and continue on the fallback engine.
        const limit =
          result.outcome === 'cancelled'
            ? null
            : assistantUsageLimit(result.errorCode, result.detail, this.#now());
        await this.#emit(turn, {
          kind: 'failed',
          reason:
            result.outcome === 'cancelled'
              ? 'cancelled'
              : limit !== null
                ? PROVIDER_USAGE_LIMIT
                : safeReason(result.errorCode),
          ...(limit !== null
            ? { detail: r.redact(limit.detail).slice(0, 500) }
            : result.detail === undefined
              ? {}
              : { detail: r.redact(result.detail).slice(0, 500) }),
          ...(limit?.resetAt === undefined ? {} : { resetAt: limit.resetAt }),
          usage: result.usage,
        });
      }
      // p15-usage-refresh: a turn on a subscription login is followed by a fresh read of its usage windows.
      if (live.auth.authMode === 'local-login') {
        this.#o.runtimeUsage?.afterRun?.(p.runtime, 'subscription', live.auth.account);
      }
      if (!live.session.alive) await this.#close(live);
    } finally {
      login.hold?.release();
      if (live !== null) {
        live.turn = null;
        live.lastUsed = Date.now();
      }
      for (const resolve of turn.calls.values()) resolve({ content: 'The turn ended.', isError: true });
      this.#turns.delete(p.turnId);
      // p17-chat-reconnect: the end may not have reached the master (stale socket, or held): kept for a resume.
      if (this.#resumeHoldMs > 0 && !turn.dropped) {
        const now = Date.now();
        this.#finished.set(p.turnId, {
          turn,
          until: turn.heldAt === null ? now + (this.#o.retainMs ?? 60_000) : turn.heldAt + this.#resumeHoldMs,
        });
      }
    }
  }

  /**
   * The turn's attachments, pulled and verified (length, SHA-256 and magic bytes against the signed ref). An
   * attachment the engine cannot take is left out with a note in the context (the master normally never sends one).
   */
  async #attachments(
    engine: AssistantEngine,
    p: AssistantTurnPayload,
    signal: AbortSignal,
  ): Promise<
    { ok: true; attachments: AssistantTurnAttachment[]; notes: string[] } | { ok: false; detail: string }
  > {
    const refs = p.attachments ?? [];
    const attachments: AssistantTurnAttachment[] = [];
    const notes: string[] = [];
    if (refs.length === 0) return { ok: true, attachments, notes };
    const input = engineInput(engine);
    const fetch = this.#o.fetchAttachment;
    for (const [i, ref] of refs.entries()) {
      const takes = ref.kind === 'pdf' ? input.pdf : input.images !== 'unsupported';
      if (!takes) {
        notes.push(
          `[The user attached ${ref.kind === 'pdf' ? 'a PDF' : 'an image'} (${safeName(ref.name)}) that this assistant engine cannot read.]`,
        );
        continue;
      }
      const label = `attachment ${String(i + 1)}`;
      if (fetch === undefined) return { ok: false, detail: `${label}: this worker cannot fetch attachments` };
      let data: Buffer;
      try {
        data = await fetch(p.turnId, ref, signal);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        return {
          ok: false,
          detail: `${label} could not be fetched (${typeof code === 'string' ? code.slice(0, 40) : 'error'})`,
        };
      }
      if (data.length !== ref.sizeBytes) return { ok: false, detail: `${label}: size does not match` };
      if (createHash('sha256').update(data).digest('hex') !== ref.sha256) {
        return { ok: false, detail: `${label}: digest does not match` };
      }
      if (!attachmentMagicMatches(data, ref.mediaType)) {
        return { ok: false, detail: `${label}: content does not match its type` };
      }
      attachments.push({ kind: ref.kind, mediaType: ref.mediaType, name: ref.name, data });
    }
    return { ok: true, attachments, notes };
  }

  async #runTurn(
    live: Live,
    turn: RunningTurn,
    p: AssistantTurnPayload,
    fresh: boolean,
    prepared: { readonly attachments: readonly AssistantTurnAttachment[]; readonly notes: readonly string[] },
    /** p10-claude-login-health: the model answered — the login store gate may go. */
    answered: () => void = () => undefined,
  ) {
    const r = this.#o.redactor;
    let buffer = '';
    let timer: NodeJS.Timeout | null = null;
    let flushing: Promise<void> = Promise.resolve();
    const flush = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      let text = buffer;
      buffer = '';
      while (text.length > 0) {
        const piece = text.slice(0, MAX_ASSISTANT_DELTA);
        text = text.slice(MAX_ASSISTANT_DELTA);
        flushing = flushing.then(() => this.#emit(turn, { kind: 'delta', text: piece }));
      }
    };
    const result = await live.session.turn(
      {
        message: p.message,
        history: fresh ? p.history : null,
        context: withNotes(p.context, prepared.notes),
        ...(prepared.attachments.length === 0 ? {} : { attachments: prepared.attachments }),
      },
      {
        delta: (text) => {
          answered();
          buffer += r.redact(text);
          if (buffer.length >= 2048) flush();
          else timer ??= setTimeout(flush, this.#o.flushMs ?? 60);
        },
      },
      turn.abort.signal,
    );
    flush();
    await flushing;
    return result;
  }

  async #toolCall(
    holder: { live: Live | null },
    tool: AssistantToolName,
    input: Record<string, unknown>,
    callId: string,
    signal: AbortSignal,
  ): Promise<AssistantToolCallResult> {
    const turn = holder.live?.turn ?? null;
    if (turn === null) return { content: 'No turn is active.', isError: true };
    if (!ASSISTANT_TOOL_NAMES.includes(tool)) return { content: `Unknown tool ${tool}.`, isError: true };
    const id = callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'call';
    const answer = new Promise<AssistantToolCallResult>((resolve) => {
      let timer: NodeJS.Timeout;
      const arm = (): void => {
        timer = setTimeout(() => {
          // p17-chat-reconnect: while the connection is down the answer cannot arrive; the hold bounds the wait.
          if (turn.heldAt !== null && !turn.dropped && !turn.abort.signal.aborted) {
            arm();
            return;
          }
          turn.calls.delete(id);
          resolve({ content: 'The platform did not answer in time.', isError: true });
        }, this.#o.toolTimeoutMs ?? 60_000);
        timer.unref();
      };
      arm();
      const onAbort = (): void => {
        clearTimeout(timer);
        turn.calls.delete(id);
        resolve({ content: 'The turn was cancelled.', isError: true });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      turn.calls.set(id, (r) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        turn.calls.delete(id);
        resolve(r);
      });
    });
    await this.#emit(turn, { kind: 'tool_call', callId: id, tool, input: jsonSafe(input) });
    return answer;
  }

  /** ASSISTANT_TOOL_RESULT: only for a call of a turn running here. */
  onToolResult(p: AssistantToolResultPayload): void {
    const entry = this.#turns.get(p.turnId);
    const resolve = entry?.turn.calls.get(p.callId);
    if (resolve === undefined) {
      this.#log.debug('tool result for an unknown call ignored', { turnId: p.turnId, callId: p.callId });
      return;
    }
    resolve({ content: p.content, isError: p.isError });
  }

  onCancel(p: AssistantCancelPayload): void {
    const entry = this.#turns.get(p.turnId);
    if (entry === undefined) return;
    this.#log.info('assistant turn cancelled', { turnId: p.turnId });
    entry.turn.abort.abort();
  }

  /**
   * The master connection dropped. p17-chat-reconnect: running turns keep running and their updates are kept (not
   * sent) until the master resumes them after the reconnect (ASSISTANT_RESUME); a turn not resumed within the hold is
   * aborted. Recently finished turns are held the same way (their end may have been lost). With `resumeHoldMs: 0`
   * running turns are aborted at once (sessions stay).
   */
  onDisconnected(): void {
    const hold = this.#resumeHoldMs;
    if (hold <= 0) {
      for (const { turn } of this.#turns.values()) turn.abort.abort();
      return;
    }
    const now = Date.now();
    let held = 0;
    for (const { turn } of this.#turns.values()) {
      if (turn.dropped) continue;
      turn.heldAt ??= now;
      held += 1;
    }
    for (const [id, f] of this.#finished) {
      if (f.until < now) {
        this.#finished.delete(id);
        continue;
      }
      if (f.turn.heldAt === null) {
        f.turn.heldAt = now;
        f.until = now + hold;
      }
    }
    if (held > 0) this.#log.info('master connection lost; assistant turns keep running', { turns: held });
    const timer = setTimeout(() => {
      this.#expireHeld();
    }, hold + 50);
    timer.unref();
  }

  /** p17-chat-reconnect: turns held longer than the hold are given up (running ones aborted). */
  #expireHeld(): void {
    const cutoff = Date.now() - this.#resumeHoldMs;
    for (const { turn } of this.#turns.values()) {
      if (turn.heldAt !== null && turn.heldAt <= cutoff && !turn.dropped) {
        this.#log.info('assistant turn not resumed by the master; stopping it', { turnId: turn.turnId });
        turn.dropped = true;
        turn.abort.abort();
      }
    }
    const now = Date.now();
    for (const [id, f] of this.#finished) if (f.until <= now) this.#finished.delete(id);
  }

  /**
   * p17-chat-reconnect: ASSISTANT_RESUME — the master holds the turn after a reconnect of this process. The updates it
   * has not processed (seq > afterSeq) are sent again in order, then the turn continues live. A turn this worker no
   * longer has (or whose log no longer reaches back to `afterSeq`) is answered `failed: assistant_disconnected`, so the
   * master applies its usual failover rules at once.
   */
  onResume(p: AssistantResumePayload): void {
    const turn = this.#turns.get(p.turnId)?.turn ?? this.#finished.get(p.turnId)?.turn;
    if (turn === undefined || turn.dropped || p.afterSeq < turn.firstSeq - 1 || p.afterSeq > turn.seq) {
      this.#log.info('assistant turn cannot be resumed', {
        turnId: p.turnId,
        afterSeq: p.afterSeq,
        known: turn !== undefined,
      });
      if (turn !== undefined) {
        turn.dropped = true;
        turn.abort.abort();
      }
      void this.#deliver({
        turnId: p.turnId,
        seq: Math.max(p.afterSeq, turn?.seq ?? 0) + 1,
        kind: 'failed',
        reason: 'assistant_disconnected',
        detail: 'The assistant machine no longer had this turn after reconnecting.',
      });
      return;
    }
    const pending = turn.log.filter((u) => u.seq > p.afterSeq);
    this.#log.info('assistant turn resumed after a reconnect', {
      turnId: p.turnId,
      afterSeq: p.afterSeq,
      resent: pending.length,
    });
    turn.heldAt = null;
    for (const u of pending) void this.#deliver(u);
    const f = this.#finished.get(p.turnId);
    if (f !== undefined) f.until = Date.now() + (this.#o.retainMs ?? 60_000);
  }

  /**
   * p17-chat-reconnect: the daemon stops on purpose — every running turn is reported lost now (the master re-runs it
   * elsewhere when its failover rules allow), then aborted without another word.
   */
  async onStopping(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const { turn } of this.#turns.values()) {
      if (turn.dropped) continue;
      if (turn.heldAt === null) {
        sends.push(
          this.#emit(turn, {
            kind: 'failed',
            reason: 'assistant_disconnected',
            detail: 'The assistant machine is stopping.',
          }),
        );
      }
      turn.dropped = true;
      turn.abort.abort();
    }
    this.#finished.clear();
    await Promise.all(sends);
  }

  async #evictOne(): Promise<boolean> {
    let oldest: Live | null = null;
    for (const l of this.#sessions.values()) {
      if (l.turn !== null) continue;
      if (oldest === null || l.lastUsed < oldest.lastUsed) oldest = l;
    }
    if (oldest === null) return false;
    await this.#close(oldest);
    return true;
  }

  async #close(live: Live): Promise<void> {
    if (this.#sessions.get(live.key) === live) this.#sessions.delete(live.key);
    await live.session.close().catch(() => undefined);
    live.auth.release();
    await rm(live.scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  async #sweep(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, f] of this.#finished) if (f.until <= now) this.#finished.delete(id);
    const cutoff = now - idleMs;
    for (const l of [...this.#sessions.values()]) {
      if (l.turn === null && (l.lastUsed < cutoff || !l.session.alive)) await this.#close(l);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#sweeper !== null) clearInterval(this.#sweeper);
    this.#sweeper = null;
    for (const { turn } of this.#turns.values()) turn.abort.abort();
    this.#finished.clear();
    await Promise.all([...this.#sessions.values()].map((l) => this.#close(l)));
  }
}

/** A session of one runtime is never reused for a turn of another (Settings → Chat switched the engine). */
function sameRuntime(live: { runtime: string }, p: { runtime: string }): boolean {
  return live.runtime === p.runtime;
}

/** What an engine takes (an engine without the field takes neither images nor PDFs). */
function engineInput(engine: AssistantEngine): NonNullable<AssistantEngine['input']> {
  return engine.input ?? { images: 'unsupported', pdf: false };
}

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._()+-]/gu, '_').slice(0, 100);
}

/** The turn's context with the host's notes appended (null when both are empty). */
function withNotes(context: string | undefined, notes: readonly string[]): string | null {
  const parts = [...(context === undefined ? [] : [context]), ...notes];
  return parts.length === 0 ? null : parts.join('\n');
}

function safeReason(code: string | undefined): string {
  const c = (code ?? 'failed')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64);
  return c === '' ? 'failed' : c;
}

/** Tool input as plain JSON (no functions, no prototypes), bounded. */
function jsonSafe(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = JSON.stringify(input);
    if (text.length > 64 * 1024) return { _truncated: true };
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
