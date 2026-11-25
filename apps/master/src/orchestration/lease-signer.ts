import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  type AdminCommandBinding,
  type ApprovalModeBinding,
  signApprovalMode,
  signTimeLimit,
  type TimeLimitBinding,
  type AdminSessionBinding,
  signAdminCommand,
  signAdminSession,
  type assistantTurnStatement,
  signAssistantTurn,
  type credentialDeliveryStatement,
  type LeaseKey,
  leaseKeyId,
  type opsCommandStatement,
  signCredentialDelivery,
  signOpsCommand,
  signLeaseToken,
  signVaultScope,
  signWorkerConfig,
  signTunnelStart,
  signTunnelStop,
  type ServiceControlBinding,
  type ServiceStartBinding,
  type ServiceTunnelBinding,
  signServiceControl,
  signServiceStart,
  signServiceTunnel,
  type IdeControlBinding,
  type IdeGitBinding,
  type IdeStartBinding,
  signIdeControl,
  signIdeGit,
  signIdeStart,
  type TunnelStartBinding,
  type tunnelStopStatement,
} from '@remyral/protocol';

export class LeaseSignerError extends Error {
  override name = 'LeaseSignerError';
}

export interface LeaseTokenInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly epoch: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Signs lease tokens with the master's Ed25519 key (ADR-0004 §1). The private key never leaves this
 * object (no getter, not serialisable); workers receive the public key in SESSION_ESTABLISHED.
 */
export class LeaseSigner {
  readonly #privateKey: KeyObject;
  readonly key: LeaseKey;

  constructor(privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new LeaseSignerError('lease signing key must be an Ed25519 private key');
    }
    this.#privateKey = privateKey;
    const raw = String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
    this.key = { kid: leaseKeyId(raw), publicKey: raw };
  }

  /** Reads a PKCS#8 PEM file (mode must not grant group/other access). Never logs the content. */
  static async fromFile(path: string): Promise<LeaseSigner> {
    let pem: string;
    try {
      const st = await stat(path);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        throw new LeaseSignerError('lease signing key file must not be readable by group/others (chmod 600)');
      }
      pem = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof LeaseSignerError) throw err;
      throw new LeaseSignerError(
        `cannot read lease signing key (LEASE_SIGNING_KEY_FILE): ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw new LeaseSignerError('lease signing key file is not a PEM private key');
    }
    return new LeaseSigner(key);
  }

  /** Development/test only: a fresh key for this process. */
  static ephemeral(): LeaseSigner {
    return new LeaseSigner(generateKeyPairSync('ed25519').privateKey);
  }

  /** Public keys workers trust (one today; rotation adds the next key here before switching). */
  keys(): readonly LeaseKey[] {
    return [this.key];
  }

  sign(input: LeaseTokenInput): string {
    return signLeaseToken(
      {
        v: 1,
        kid: this.key.kid,
        jobId: input.jobId,
        attemptId: input.attemptId,
        workerId: input.workerId,
        epoch: input.epoch,
        iat: input.issuedAt.toISOString(),
        exp: input.expiresAt.toISOString(),
      },
      this.#privateKey,
    );
  }

  /**
   * Job secret references: the vault scope of an ASSIGN_JOB lease — the vault credential ids the attempt may receive
   * through `spec.secretRefs` (lease.ts `signVaultScope`; the worker drops every other vault reference).
   */
  signVaultScope(
    input: Omit<LeaseTokenInput, 'issuedAt' | 'expiresAt'> & { readonly vault: readonly string[] },
  ): string {
    return signVaultScope(
      {
        v: 1,
        kid: this.key.kid,
        jobId: input.jobId,
        attemptId: input.attemptId,
        workerId: input.workerId,
        epoch: input.epoch,
        vault: [...input.vault],
      },
      this.#privateKey,
    );
  }

  /** ADR-0015: detached signature over an APPLY_WORKER_CONFIG statement (worker, generation, hash, time). */
  signWorkerConfig(input: {
    readonly workerId: string;
    readonly generation: number;
    readonly documentHash: string;
    readonly issuedAt: string;
  }): { kid: string; signature: string } {
    return signWorkerConfig(input, this.key.kid, this.#privateKey);
  }

  /** p5-credentials-models: detached signature over an APPLY_CREDENTIAL / REVOKE_CREDENTIAL statement. */
  signCredentialDelivery(input: Parameters<typeof credentialDeliveryStatement>[0]): {
    kid: string;
    signature: string;
  } {
    return signCredentialDelivery(input, this.key.kid, this.#privateKey);
  }

  /** p5-remote-ops: detached signature over an OPS_COMMAND statement (worker, command, window, operation). */
  signOpsCommand(input: Parameters<typeof opsCommandStatement>[0]): { kid: string; signature: string } {
    return signOpsCommand(input, this.key.kid, this.#privateKey);
  }

  /** p5-ops-chat: detached signature over an ASSISTANT_TURN statement (worker, turn, window, content). */
  signAssistantTurn(input: Parameters<typeof assistantTurnStatement>[0]): { kid: string; signature: string } {
    return signAssistantTurn(input, this.key.kid, this.#privateKey);
  }

  /** p5-machine-admin: one elevated command, bound to worker, job, attempt, epoch, request, window and operation. */
  signAdminCommand(input: AdminCommandBinding): { kid: string; signature: string } {
    return signAdminCommand(input, this.key.kid, this.#privateKey);
  }

  /** p5-machine-admin: the session grant the root/SYSTEM helper starts an elevated broker for. */
  signAdminSession(input: AdminSessionBinding): { kid: string; signature: string } {
    return signAdminSession(input, this.key.kid, this.#privateKey);
  }

  /** p6-approval-mode-switch: a running job's new approval mode (worker, job, attempt, epoch, change, seq, mode). */
  signApprovalMode(input: ApprovalModeBinding): { kid: string; signature: string } {
    return signApprovalMode(input, this.key.kid, this.#privateKey);
  }

  /** p15-autonomy: a running job's new time limit (worker, job, attempt, epoch, change, seq, limit). */
  signTimeLimit(input: TimeLimitBinding): { kid: string; signature: string } {
    return signTimeLimit(input, this.key.kid, this.#privateKey);
  }

  /**
   * p17-domain-wizard (ADR-0063 amendment 2026-10-24): a detached signature over a document for the remyral-ctl host
   * applier — Ed25519 over `context + "\n"` ‖ the exact bytes (the construction `remyral-ctl` verifies with
   * `openssl pkeyutl -verify -rawin`). The context names the document type, so it never verifies as a worker statement.
   */
  signHostDocument(context: string, bytes: Buffer): { kid: string; signature: string } {
    if (!/^remyral-host-[a-z-]+\/v[0-9]+$/.test(context)) {
      throw new LeaseSignerError('host document context must be remyral-host-<name>/v<n>');
    }
    const signed = Buffer.concat([Buffer.from(`${context}\n`, 'utf8'), bytes]);
    return { kid: this.key.kid, signature: sign(null, signed, this.#privateKey).toString('base64url') };
  }

  toJSON(): unknown {
    return { kid: this.key.kid };
  }

  /** p8-preview-tunnels (ADR-0032): one preview connector start (worker, job, attempt, tunnel, port, window, token hash). */
  signTunnelStart(input: TunnelStartBinding): { kid: string; signature: string } {
    return signTunnelStart(input, this.key.kid, this.#privateKey);
  }

  /** p15-services: one service start / update (worker, service, revision, time, spec hash). */
  signServiceStart(input: ServiceStartBinding): { kid: string; signature: string } {
    return signServiceStart(input, this.key.kid, this.#privateKey);
  }

  /** p19-ide W2: one start of an IDE workspace (worker, revision, spec hash). */
  signIdeStart(input: IdeStartBinding): { kid: string; signature: string } {
    return signIdeStart(input, this.key.kid, this.#privateKey);
  }

  /** p19-ide W2: one stop / remove of an IDE workspace. */
  signIdeControl(input: IdeControlBinding): { kid: string; signature: string } {
    return signIdeControl(input, this.key.kid, this.#privateKey);
  }

  /** p19-ide W2: one git status / push of an IDE workspace (request id, commit message hash). */
  signIdeGit(input: IdeGitBinding): { kid: string; signature: string } {
    return signIdeGit(input, this.key.kid, this.#privateKey);
  }

  /** p15-services: one stop / restart / remove of a service. */
  signServiceControl(input: ServiceControlBinding): { kid: string; signature: string } {
    return signServiceControl(input, this.key.kid, this.#privateKey);
  }

  /** p15-services: the connector of a service's named tunnel (token hash, hostname, port, window). */
  signServiceTunnel(input: ServiceTunnelBinding): { kid: string; signature: string } {
    return signServiceTunnel(input, this.key.kid, this.#privateKey);
  }

  /** p8-preview-tunnels: one preview connector stop. */
  signTunnelStop(input: Parameters<typeof tunnelStopStatement>[0]): { kid: string; signature: string } {
    return signTunnelStop(input, this.key.kid, this.#privateKey);
  }
}
