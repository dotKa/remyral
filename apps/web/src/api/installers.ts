import {
  API_PREFIX,
  apiRequest,
  int,
  nullableStr,
  obj,
  type RequestOptions,
  ShapeError,
  str,
  strArray,
} from './client';

/** Typed wrapper for `GET /installers` (apps/master/src/installers/routes.ts, p5-worker-onboarding). */

export type InstallerOs = 'linux' | 'macos' | 'windows';

export interface InstallCommands {
  readonly bootstrapUrl: string;
  readonly bootstrapSha256: string;
  readonly download: string;
  readonly run: string;
}

export interface InstallerKitInfo {
  readonly os: InstallerOs;
  readonly file: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly commands: InstallCommands | null;
  readonly kitUrl: string | null;
}

export interface InstallerOverview {
  readonly publicOrigin: string | null;
  readonly masterUrl: string | null;
  readonly publicDownloads: boolean;
  readonly current: {
    readonly version: string;
    readonly channel: string;
    readonly stable: boolean;
    readonly keyId: string;
    readonly nodeVersion: string;
    readonly uploadedAt: string;
    readonly kits: readonly InstallerKitInfo[];
  } | null;
  readonly withoutKits: readonly string[];
}

const OSES: readonly string[] = ['linux', 'macos', 'windows'];

function kit(o: Record<string, unknown>): InstallerKitInfo {
  const os = str(o, 'os');
  if (!OSES.includes(os)) throw new ShapeError('unknown os');
  const c = o.commands;
  let commands: InstallCommands | null = null;
  if (c !== null && c !== undefined) {
    const co = obj(c);
    commands = {
      bootstrapUrl: str(co, 'bootstrapUrl'),
      bootstrapSha256: str(co, 'bootstrapSha256'),
      download: str(co, 'download'),
      run: str(co, 'run'),
    };
  }
  return {
    os: os as InstallerOs,
    file: str(o, 'file'),
    sha256: str(o, 'sha256'),
    sizeBytes: int(o, 'sizeBytes'),
    commands,
    kitUrl: nullableStr(o, 'kitUrl'),
  };
}

export function getInstallers(opts: Omit<RequestOptions, 'body'> = {}): Promise<InstallerOverview> {
  return apiRequest(
    'GET',
    '/installers',
    (v) => {
      const o = obj(v);
      const cur = o.current;
      let current: InstallerOverview['current'] = null;
      if (cur !== null && cur !== undefined) {
        const c = obj(cur);
        if (!Array.isArray(c.kits)) throw new ShapeError('expected kits[]');
        current = {
          version: str(c, 'version'),
          channel: str(c, 'channel'),
          stable: c.stable === true,
          keyId: str(c, 'keyId'),
          nodeVersion: str(c, 'nodeVersion'),
          uploadedAt: str(c, 'uploadedAt'),
          kits: c.kits.map((k) => kit(obj(k))),
        };
      }
      return {
        publicOrigin: nullableStr(o, 'publicOrigin'),
        masterUrl: nullableStr(o, 'masterUrl'),
        publicDownloads: o.publicDownloads === true,
        current,
        withoutKits: strArray(o, 'withoutKits'),
      };
    },
    opts,
  );
}

/** Signed-in bundle download (same-origin session cookie; audited by the master). */
export function kitDownloadPath(version: string, os: InstallerOs): string {
  return `${API_PREFIX}/installers/${encodeURIComponent(version)}/${os}/kit`;
}
