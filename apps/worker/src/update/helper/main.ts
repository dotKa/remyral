import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createLogger, Redactor, type LogSink } from '@remyral/observability';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@remyral/protocol';
import { collectUpdateDiagnostics, readTailSafe } from '../../boot/diagnostics.js';
import { ConfigError } from '../../config/load.js';
import type { PathHost } from '../../config/paths.js';
import { createNodeFileOps, type FileOps } from '../../fs/ops.js';
import { WORKER_VERSION } from '../../version.js';
import { FileLog } from '../../remote-ops/logs.js';
import { serviceDefinition } from '../../service/definitions.js';
import type { System } from '../../system/types.js';
import { COMPILED_RELEASE_KEYS, trustedReleaseKeys } from '../keys.js';
import { dataLayout, defaultInstallDir, installLayout, UPDATER_LOG_NAME } from '../layout.js';
import { loadUpdaterConfig } from './config.js';
import { osServiceControl } from './service-control.js';
import { Updater, UpdaterError, type ServiceControl } from './updater.js';
import {
  nodeExec,
  PREPARE_HELPER,
  PrivilegedPreparer,
  requestSandboxPackages,
  type PrivilegedPrepareDeps,
} from './prepare.js';
import { ADMIN_BINDING, ADMIN_HELPER, AdminHelper, type AdminHelperDeps, nodeAdminExec } from './admin.js';
import { adminBind } from './bind.js';
import { assessHostConfinement } from './host-confinement.js';
import { setMachineAdminCeiling } from './ceiling.js';
import { readAdminBinding } from '../../machine-admin/binding.js';
import { MANAGE_HELPER, ManageHelper, type ManageHelperDeps } from './manage.js';
import { removeLegacyAcl } from './legacy-acl.js';
import * as nodePath from 'node:path';

/** p6-worker-boot-diagnostics: `<installDir>/state/updater.log` rotates at this size (one older generation). */
const UPDATER_LOG_BYTES = 1024 * 1024;

/** Minimum Node for releases built from this tree (root package.json engines). */
export const RELEASE_MIN_NODE = '24.11.0';

export const UPDATER_USAGE = `Usage: remyral-worker-updater <command> [options]   (privileged: root / Administrator / SYSTEM)

  apply                 Process a pending activation request from the worker (run by the service
                        manager: systemd path unit, launchd WatchPaths, Windows scheduled task).
                        Verifies the staged release again, activates it atomically, restarts the
                        service and rolls back if the new version does not become healthy.
  rollback [--to V]     Switch back to a retained version (default: the previous one) and restart.
  adopt --bundle F --manifest F --signature F [--allow-downgrade]
                        Installer step: verify a signed release and make it the active bundle.
  verify --bundle F --manifest F --signature F
                        Verify a release against the trusted release keys; changes nothing.
  prepare               Process a pending privileged sandbox-prepare request (p5-sandbox-ops): verify the
                        master's signature on it and run this OS's fixed allowlist of steps (Linux: run
                        by remyral-worker-prepare.path; Windows/macOS: \`apply\` does it too). Linux: also
                        installs the fixed bubblewrap package when it is missing (\`apply\` starts it then).
  admin-session         Run a pending AI machine-administration session (p5-machine-admin, ADR-0021): verify
                        the master's session grant, then run each master-signed elevated command of that
                        job attempt until the session ends (Windows: task RemyralWorkerAdmin; Linux:
                        remyral-worker-admin.path; macOS: com.remyral.worker.admin).
  admin-bind [--worker-id ID] [--replace] [--if-unbound]
                        Record which worker this machine's helper serves (<install>/state/admin-binding.json,
                        root-owned): the enrolled identity from the worker's data dir, printed with its device
                        key fingerprint to compare with the console. Machine-admin sessions are refused until it
                        exists; sessions, commands and privileged requests signed for another worker always.
                        --worker-id: the id you expect (refused on a mismatch); --replace: the machine was
                        paired again; --if-unbound: installer mode (only when unbound; never fails).
  machine-admin-ceiling allow|forbid|unset
                        Set localCeiling.allowMachineAdmin in the root-owned config (installers'
                        --allow-machine-admin / --no-machine-admin on an existing config): forbid = the
                        local veto, allow = explicit opt-in, unset = the default. Validated before it is
                        written; restart the worker afterwards.
  status [--json]       Active version, retained versions, last outcome.
  info                  Build facts for the release tooling (version, protocol versions, keys).

Options: --config <path> (worker config; default per OS), --install-dir <dir>.
Exit codes: 0 ok / nothing to do, 1 refused / failed / rolled back, 2 crash or bad arguments,
78 configuration problem.`;

export interface UpdaterIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface UpdaterHost {
  sys: System;
  pathHost: PathHost;
  ops?: FileOps;
  service?: ServiceControl;
  logSink?: LogSink;
  /** Test seam: owner the config must have (default root). */
  configOwnerUid?: number;
  /** Test seam: privileged prepare dependencies. */
  prepare?: Partial<PrivilegedPrepareDeps>;
  /** Test seam: machine-admin broker dependencies. */
  admin?: Partial<AdminHelperDeps>;
  /** Test seam: removal / helper management dependencies (p17-worker-managed). */
  manage?: Partial<ManageHelperDeps>;
}

export async function updaterMain(
  argv: readonly string[],
  host: UpdaterHost,
  io: UpdaterIo,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        'install-dir': { type: 'string' },
        bundle: { type: 'string' },
        manifest: { type: 'string' },
        signature: { type: 'string' },
        to: { type: 'string' },
        json: { type: 'boolean', default: false },
        'allow-downgrade': { type: 'boolean', default: false },
        'worker-id': { type: 'string' },
        replace: { type: 'boolean', default: false },
        'if-unbound': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${UPDATER_USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || command === undefined) {
    if (values.help) io.stdout(`${UPDATER_USAGE}\n`);
    else io.stderr(`${UPDATER_USAGE}\n`);
    return values.help ? 0 : 2;
  }
  if (command === 'info') {
    io.stdout(
      `${JSON.stringify({
        version: WORKER_VERSION,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        minNode: RELEASE_MIN_NODE,
        releaseKeys: COMPILED_RELEASE_KEYS,
        features: [PREPARE_HELPER, ADMIN_HELPER, MANAGE_HELPER, ADMIN_BINDING],
      })}\n`,
    );
    return 0;
  }

  const ops = host.ops ?? createNodeFileOps();
  const platform = host.pathHost.platform;
  let fileLog: FileLog | null = null;
  try {
    const needsConfig =
      command === 'apply' ||
      command === 'rollback' ||
      command === 'prepare' ||
      command === 'admin-session' ||
      command === 'admin-bind' ||
      command === 'machine-admin-ceiling';
    const config = await loadUpdaterConfig(ops, host.pathHost, values.config, {
      optional: !needsConfig,
      // p17-worker-managed: the panel's updates.* (narrowing only) for the commands that update.
      panel: command === 'apply' || command === 'rollback',
      ...(host.configOwnerUid === undefined ? {} : { ownerUid: host.configOwnerUid }),
    });
    const installDir =
      values['install-dir'] ??
      config.settings.installDir ??
      defaultInstallDir(platform, (name) => host.pathHost.env(name));
    const def = serviceDefinition(platform);
    const service =
      host.service ??
      (def === null
        ? {
            restart: () => Promise.reject(new Error(`no service manager for ${platform}`)),
            mainPid: () => Promise.resolve(null),
          }
        : osServiceControl(host.sys, def));
    const install = installLayout(platform, installDir);
    const redactor = new Redactor();
    // p6-worker-boot-diagnostics: the updater's own log file (Windows had none: a scheduled task's output is
    // discarded). Root-owned, readable by the service account (remote `logs.tail` source `updater`), two
    // generations of 1 MiB. Only commands that change something write it (status / info / verify stay silent).
    const writesLog = command === 'apply' || command === 'rollback' || command === 'adopt';
    fileLog = writesLog
      ? new FileLog('', UPDATER_LOG_BYTES, { dir: install.stateDir, name: UPDATER_LOG_NAME, mode: 0o644 })
      : null;
    const stderrSink: LogSink =
      host.logSink ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
    const logger = createLogger({
      redactor,
      sink: fileLog === null ? stderrSink : fileLog.tee(stderrSink),
      fields: { service: 'remyral-worker-updater', version: WORKER_VERSION },
    });
    if (config.panelUpdates !== undefined) {
      logger.info('panel update settings taken over', { keys: config.panelUpdates });
    }
    const data = dataLayout(platform, config.dataDir);
    const updater = new Updater({
      ops,
      install,
      data,
      settings: config.settings,
      trustedKeys: trustedReleaseKeys(config.settings.releaseKeys),
      service,
      logger,
      collectDiagnostics: async ({ version, since, restartErrors }) => {
        // Files in the data dir belong to the service account: read only files it owns (POSIX), never a link.
        const owner = (await ops.lstat(config.dataDir).catch(() => null))?.uid;
        const ownerUid = owner === undefined || owner < 0 ? null : owner;
        return collectUpdateDiagnostics({
          collectedBy: 'updater',
          platform,
          env: (name) => host.pathHost.env(name),
          dataDir: config.dataDir,
          updaterLog: install.updaterLog,
          version,
          since,
          read: (path, max) =>
            readTailSafe(path, max, path.startsWith(install.installDir) ? {} : { ownerUid }),
          ...(def?.manager === 'systemd'
            ? {
                journal: async () => {
                  const r = await host.sys.exec(
                    'journalctl',
                    [
                      '-u',
                      def.name,
                      '--since',
                      `@${String(Math.floor(since.getTime() / 1000))}`,
                      '-n',
                      '80',
                      '-o',
                      'cat',
                      '--no-pager',
                    ],
                    { timeoutMs: 15_000 },
                  );
                  return r.exitCode === 0 ? r.stdout : null;
                },
              }
            : {}),
          restartErrors,
          redactor,
        });
      },
    });

    // The worker id this machine's helper serves (root-owned; machine-admin/binding.ts).
    const binding = () =>
      readAdminBinding(installDir, {
        platform,
        rootOnly: true,
        ...(host.configOwnerUid === undefined ? {} : { ownerUid: host.configOwnerUid }),
      });
    const preparer = async (): Promise<PrivilegedPreparer> =>
      new PrivilegedPreparer({
        platform,
        configPath: config.path ?? '',
        dataDir: config.dataDir,
        installDir,
        pinnedKeys: config.masterLeaseKeys ?? null,
        masterUrl: config.masterUrl ?? '',
        logger,
        // Live finding 2026-10-17: new Windows privileges need a full service stop/start (same path as activations).
        restartService: () => service.restart(),
        binding: await binding(),
        // p17-worker-managed: worker.uninstall / helper.manage through the same signed request and trigger.
        manage: new ManageHelper({
          platform,
          configPath: config.path ?? '',
          dataDir: config.dataDir,
          installDir,
          nodePath: process.execPath,
          allowMachineAdmin: config.allowMachineAdmin !== false,
          logger,
          ...host.manage,
        }),
        ...host.prepare,
      });
    const runPrepare = async (): Promise<number> => {
      const p = await preparer();
      const r = await p.processRequest();
      // p19-auto-bwrap: the Linux prepare unit also installs the fixed sandbox packages when they are missing
      // (no request needed; best effort). Not after a removal / helper-management request.
      if (platform === 'linux' && (r === null || 'restartRequired' in r)) await p.ensureSandboxPackages();
      if (r === null) return 0;
      io.stdout(`${JSON.stringify({ prepare: r.commandId, state: r.state, reason: r.reason })}\n`);
      return r.state === 'refused' ? 1 : 0;
    };

    switch (command) {
      case 'apply': {
        // A request written while we were busy may not re-trigger the service manager: drain them.
        let code = 0;
        for (let i = 0; i < 5; i++) {
          const out = await updater.apply();
          if (out.kind === 'idle') break;
          io.stdout(`${JSON.stringify(out.result)}\n`);
          code = out.result.outcome === 'succeeded' ? 0 : 1;
        }
        // p17-worker-managed: on Windows, once per install, the pre-rename service account's leftover ACL entry.
        if (platform === 'win32' && config.path !== null) {
          const root = nodePath.dirname(config.path);
          await removeLegacyAcl({
            installDir,
            dirs: [
              root,
              config.dataDir,
              nodePath.join(root, 'logs'),
              ...(config.workspaceRoot ? [config.workspaceRoot] : []),
            ],
            exec: host.prepare?.exec ?? nodeExec,
            logger,
          }).catch((err: unknown) => {
            logger.warn('legacy ACL cleanup failed', { err });
          });
        }
        // p5-sandbox-ops: Windows (scheduled task) and macOS (WatchPaths) have one trigger for both; Linux runs
        // `prepare` from its own unit (network for packages; the update unit has none).
        if (platform !== 'linux') {
          const p = await runPrepare();
          if (code === 0) code = p;
        } else {
          // p19-auto-bwrap: after an activation (and at boot) a missing bubblewrap is installed by the prepare unit.
          await requestSandboxPackages({ platform, exec: host.prepare?.exec ?? nodeExec, logger });
        }
        return code;
      }
      case 'prepare':
        return await runPrepare();
      case 'admin-session': {
        const helper = new AdminHelper({
          platform,
          dataDir: config.dataDir,
          installDir,
          pinnedKeys: config.masterLeaseKeys ?? null,
          masterUrl: config.masterUrl ?? '',
          allowMachineAdmin: config.allowMachineAdmin !== false,
          binding: await binding(),
          // Security fix: no machine administration while host jobs here run unconfined, unless opted in explicitly.
          machineAdminOptIn: config.machineAdminOptIn === true,
          configPath: config.path ?? '',
          hostConfinement: () =>
            assessHostConfinement({
              platform,
              configDir: nodePath.dirname(config.path ?? ''),
              sandbox: config.sandbox ?? {},
              exec: host.admin?.exec ?? nodeAdminExec,
            }),
          logger,
          ...host.admin,
        });
        const r = await helper.runPending();
        if (r.state !== 'idle') {
          io.stdout(
            `${JSON.stringify({ adminSession: r.sessionId, state: r.state, reason: r.reason, commands: r.commands })}\n`,
          );
        }
        return r.state === 'refused' ? 1 : 0;
      }
      case 'machine-admin-ceiling': {
        const value = positionals[1];
        if (value !== 'allow' && value !== 'forbid' && value !== 'unset') {
          io.stderr(`machine-admin-ceiling needs allow, forbid or unset\n`);
          return 2;
        }
        if (config.path === null) {
          io.stderr('no config file\n');
          return 78;
        }
        return await setMachineAdminCeiling({
          platform,
          configPath: config.path,
          value,
          out: (t) => {
            io.stdout(t);
          },
        });
      }
      case 'admin-bind':
        return await adminBind({
          platform,
          dataDir: config.dataDir,
          installDir,
          workerId: values['worker-id'],
          ifUnbound: values['if-unbound'],
          replace: values.replace,
          now: () => new Date(),
          out: (t) => {
            io.stdout(t);
          },
          ...(host.configOwnerUid === undefined ? {} : { ownerUid: host.configOwnerUid }),
        });
      case 'rollback': {
        const result = await updater.rollback(values.to);
        io.stdout(`${JSON.stringify(result)}\n`);
        return result.outcome === 'succeeded' ? 0 : 1;
      }
      case 'adopt':
      case 'verify': {
        if (values.bundle === undefined || values.manifest === undefined || values.signature === undefined) {
          io.stderr(`${command} needs --bundle, --manifest and --signature\n`);
          return 2;
        }
        const [artifact, manifest, sigRaw] = await Promise.all([
          readFile(values.bundle),
          readFile(values.manifest),
          readFile(values.signature, 'utf8'),
        ]);
        let signature: unknown;
        try {
          signature = JSON.parse(sigRaw);
        } catch {
          io.stderr('signature file is not JSON\n');
          return 1;
        }
        if (command === 'verify') {
          const m = updater.verifyRelease(manifest, signature, artifact);
          io.stdout(`verified: remyral-worker ${m.version} (${m.channel}, sha256 ${m.sha256})\n`);
          return 0;
        }
        const r = await updater.adopt({
          manifest,
          signature,
          artifact,
          allowDowngrade: values['allow-downgrade'],
        });
        io.stdout(`${r.changed ? 'activated' : 'unchanged'}: remyral-worker ${r.version}\n`);
        return 0;
      }
      case 'status': {
        const st = await updater.status();
        if (values.json) {
          io.stdout(`${JSON.stringify(st, null, 2)}\n`);
        } else {
          io.stdout(
            [
              `Active:    ${st.active?.version ?? 'unversioned'} (sha256 ${st.bundleSha256 ?? 'none'})`,
              `Retained:  ${st.retained.join(', ') || 'none'}`,
              `Updater:   ${st.state.phase}${st.state.target ? ` → ${st.state.target.version}` : ''}`,
              `Last:      ${st.lastResult ? `${st.lastResult.version} ${st.lastResult.outcome}${st.lastResult.reason ? ` (${st.lastResult.reason})` : ''} at ${st.lastResult.finishedAt}` : 'none'}`,
              '',
            ].join('\n'),
          );
        }
        return 0;
      }
      default:
        io.stderr(`Unknown command: ${command}\n\n${UPDATER_USAGE}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`remyral-worker-updater: ${error.message}\n`);
      return 78;
    }
    if (error instanceof UpdaterError) {
      io.stderr(`remyral-worker-updater: refused (${error.reason}): ${error.message}\n`);
      return 1;
    }
    io.stderr(`remyral-worker-updater crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    fileLog?.close();
  }
}
