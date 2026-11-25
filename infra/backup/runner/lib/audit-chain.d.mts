// Types of audit-chain.mjs for the master's TypeScript tests (the runner itself is plain ESM).
export interface AuditRowJson {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly outcome: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: unknown;
  readonly prevHash: string;
  readonly hash?: string;
}
export declare const GENESIS_HASH_HEX: string;
export declare function canonicalJson(value: unknown): string;
export declare function eventHashHex(row: AuditRowJson): string;
export declare function auditBatchSql(afterId: string, limit: number): string;
export declare function verifyAuditChain(
  queryJson: (sql: string) => Promise<unknown>,
  batchSize?: number,
): Promise<
  | { ok: true; checked: number; headId: string | null; headHash: string | null }
  | { ok: false; checked: number; brokenAtId: string; reason: 'prev_hash_mismatch' | 'hash_mismatch' }
>;
