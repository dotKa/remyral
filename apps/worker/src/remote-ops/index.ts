import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export { RemoteOpsAgent, type OpsGroup, type RemoteOpsDeps } from './agent.js';
export { collectDiagnostics } from './diagnostics.js';
export { InstallError } from './fetch.js';
export { InstallRefusal, RuntimeInstaller } from './installer.js';
export { INSTALL_MANIFEST } from './install-manifest.generated.js';
export { applyRunLogin, LoginManager } from './login.js';
export { LoginHealthMonitor } from './login-health.js';
export { FileLog, tailLog } from './logs.js';
export { hostPlatform, type InstallManifest } from './manifest.js';
export { runProcess, type RunFn } from './process.js';
export { detectService, EXIT_RESTART, type ServiceInfo } from './service-control.js';

/** First executable named `name` on PATH (PATHEXT on Windows); null when absent. */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.toUpperCase() === '.EXE')
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      try {
        await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        // next
      }
    }
  }
  return null;
}
