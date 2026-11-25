import type {
  DeviceAuthRequest,
  DeviceAuthResult,
  DeviceDirectory,
  RefusalCode,
  WorkerSession,
  WorkerSessionHandler,
} from '../../src/workers/types.js';
import type { WorkerToMaster } from '@remyral/protocol';

/** In-memory device directory for gateway tests (the Postgres one is p2-pairing). */
export class MemoryDirectory implements DeviceDirectory {
  readonly active = new Map<string, string>();
  readonly refused = new Map<string, RefusalCode>();
  readonly requests: DeviceAuthRequest[] = [];
  resumeFromSeq = 0;
  /**
   * The clock a pairing request's expiry is counted from. The gateway times the pending socket against the harness
   * clock, so a test with a harness sets this to `h.clock.now`; a wall-clock expiry would lie weeks past the harness
   * instant and the timer (over 2^31 ms) would fire at once.
   */
  clock: () => Date = () => new Date();

  authenticate(request: DeviceAuthRequest): Promise<DeviceAuthResult> {
    this.requests.push(request);
    const refusal = this.refused.get(request.publicKey);
    if (refusal !== undefined) return Promise.resolve({ kind: 'refused', code: refusal, message: refusal });
    const workerId = this.active.get(request.publicKey);
    if (workerId !== undefined) {
      return Promise.resolve({ kind: 'session', workerId, resumeFromSeq: this.resumeFromSeq });
    }
    if (request.pairingCode !== null) {
      return Promise.resolve({
        kind: 'pending',
        workerId: `wrk_pending_${String(this.requests.length)}`,
        expiresAt: new Date(this.clock().getTime() + 600_000),
      });
    }
    return Promise.resolve({ kind: 'refused', code: 'unauthenticated', message: 'unknown device' });
  }

  isActive(workerId: string, publicKey: string): Promise<boolean> {
    return Promise.resolve(this.active.get(publicKey) === workerId && !this.refused.has(publicKey));
  }
}

/** Records everything the gateway hands to the session layer. */
export class RecordingHandler implements WorkerSessionHandler {
  readonly started: WorkerSession[] = [];
  readonly messages: WorkerToMaster[] = [];
  readonly ended: { workerId: string; reason: string }[] = [];
  delayMs = 0;

  onSessionStart(session: WorkerSession): Promise<void> {
    this.started.push(session);
    return Promise.resolve();
  }
  async onMessage(_session: WorkerSession, message: WorkerToMaster): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.messages.push(message);
  }
  onSessionEnd(session: WorkerSession, reason: string): Promise<void> {
    this.ended.push({ workerId: session.workerId, reason });
    return Promise.resolve();
  }
}
