// Types of proc.mjs for the master's TypeScript tests.
import type { ChildProcess } from 'node:child_process';

export interface ToolOptions {
  readonly stdin?: number | string | Buffer | 'pipe';
  readonly stdout?: number | 'pipe' | 'stream';
  readonly env?: Record<string, string>;
  readonly uid?: number;
  readonly gid?: number;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly allowFail?: boolean;
  readonly onStdout?: (d: Buffer) => void;
}
export interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface Tools {
  spawn(
    cmd: string,
    args: readonly string[],
    opts?: ToolOptions,
  ): { child: ChildProcess; done: Promise<ToolResult> };
  run(cmd: string, args: readonly string[], opts?: ToolOptions): Promise<ToolResult>;
}
export declare function spawnTool(
  cmd: string,
  args: readonly string[],
  opts?: ToolOptions,
): { child: ChildProcess; done: Promise<ToolResult> };
export declare const localTools: Tools;
export declare function tail(text: string, lines?: number): string;
