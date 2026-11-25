// Types of pg.mjs for the master's TypeScript tests.
import type { Tools } from './proc.mjs';

export interface Inspection {
  readonly serverVersion: string;
  readonly schema: { readonly version: string; readonly count: number };
  readonly rowCounts: Record<string, number>;
  readonly fingerprints: readonly { readonly table: string; readonly id: string; readonly sha256: string }[];
  readonly auditHead: { readonly id: string; readonly hash: string } | null;
}
export interface ManifestLike {
  readonly schema: { readonly version: string; readonly count: number };
  readonly tables: Record<string, number>;
  readonly fingerprints: readonly { readonly table: string; readonly id: string; readonly sha256: string }[];
  readonly auditHead: { readonly id: string; readonly hash: string } | null;
}
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}
export declare const SESSION_SETTINGS: readonly string[];
export declare const FINGERPRINT_TABLES: readonly string[];
export declare class PsqlSession {
  static open(
    tools: Tools,
    opts?: { env?: Record<string, string>; args?: readonly string[]; uid?: number; gid?: number },
  ): PsqlSession;
  query(sql: string): Promise<string>;
  queryJson(sql: string): Promise<unknown>;
  close(): Promise<unknown>;
}
export declare function inspectDatabase(queryJson: (sql: string) => Promise<unknown>): Promise<Inspection>;
export declare function sha256File(path: string): Promise<{ sha256: string; bytes: number }>;
export declare function dumpWithSnapshot(opts: {
  tools: Tools;
  env: Record<string, string>;
  outFd: number;
}): Promise<{ snapshot: string; inspection: Inspection; pgDumpVersion: string }>;
export declare function loadMigrationFiles(dir: string): MigrationFile[];
export declare function compareMigrations(
  applied: readonly { version: string; checksum: string }[],
  files: readonly { version: string; checksum: string }[],
): { ok: boolean; unknown: string[]; mismatched: string[]; pending: string[] };
export declare function verifyRestored(opts: {
  queryJson: (sql: string) => Promise<unknown>;
  manifest: ManifestLike;
  migrations: readonly MigrationFile[] | null;
}): Promise<Check[]>;
