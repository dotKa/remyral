import { join } from 'node:path';
import type { IdeServerKind } from '@remyral/protocol';
import type { IdeServerInstall } from './server.js';

/**
 * p19-ide W2b (docs/design/p19-ide.md "Implementation (W2b)"): how one IDE workspace's server is started — the launch
 * contract of each pinned server, as data the manager executes. Both serve one workspace folder on a free loopback
 * port, keep their state in the workspace's run dir, and accept nothing on that port without a per-start random
 * secret; the worker's gateway (gateway.ts) adds the secret upstream, so the browser never needs it.
 *
 * - **openvscode-server** (Linux, W2): `--connection-token-file` (cookie `vscode-tkn`, which the browser's workbench
 *   also needs for its WebSocket handshake → the gateway sets it on HTML answers), `--server-base-path /w/<id>` (the
 *   gateway forwards the path unchanged). Ready: `<base>/version` answers 200 and `<base>/` without the token 403.
 * - **code-server** (macOS / Windows, W2b; 4.143.1 read 2026-10-29): no connection token of its own (it runs VS Code's
 *   server in-process with `without-connection-token`, routes/vscode.js) — its password auth is the gate instead.
 *   `hashed-password` (config file only: `cli.js` refuses it on the command line) holds the random secret; a value
 *   without `$argon` is the legacy method, for which the session cookie is valid iff it **equals** that value
 *   (`util.js isCookieValid`, `safe-compare`), so the gateway sends `code-server-session=<secret>` on every request and
 *   upgrade. code-server serves at `/` with relative URLs only (`http.js relativeRoot`, relative redirects), so the
 *   gateway strips `/w/<id>`. `--disable-proxy` removes its `/proxy/<port>` and `/absproxy/<port>` routes (they would
 *   reach any loopback port of the machine), `--disable-update-check` / `--disable-telemetry` keep it off GitHub and
 *   telemetry, `--ignore-last-opened` always opens the workspace folder, and `EXTENSIONS_GALLERY={}` switches the
 *   gallery off: without that variable code-server falls back to open-vsx.org even when product.json has no gallery
 *   (`lib/vscode/out/server-main.js`). Ready: `/healthz` answers 200, a path behind its auth answers 401 without the
 *   cookie and something else with it (so a wrong secret scheme fails the start instead of exposing a login page).
 *   Variables that would override the bind address or the password (`PORT`, `CODE_SERVER_HOST`, `PASSWORD`,
 *   `HASHED_PASSWORD`, …) are removed from its environment.
 */

export interface IdeLaunchDirs {
  /** The workspace's run dir (`<root>/sandboxes/ide-<id>/run`, the sandbox dir). */
  readonly run: string;
  readonly home: string;
  readonly ext: string;
  readonly userData: string;
  readonly serverData: string;
}

export interface IdeLaunchInput {
  readonly install: IdeServerInstall;
  readonly platform: NodeJS.Platform;
  readonly port: number;
  /** The per-start secret (base64url, 43 characters). */
  readonly token: string;
  /** `/w/<workspaceId>` */
  readonly basePath: string;
  readonly dirs: IdeLaunchDirs;
  /** The workspace folder the IDE opens. */
  readonly folder: string;
}

export interface IdeReadiness {
  /** Answers 200 once the server listens (no auth). */
  readonly readyPath: string;
  /** Requested without the secret: must answer one of `anonymousStatus`, else the server is open to the machine. */
  readonly anonymousPath: string;
  readonly anonymousStatus: readonly number[];
  /** Requested with the secret cookie: must not answer 401 / 403 (the secret scheme works). */
  readonly authedPath?: string;
  /** `name=value` of the secret cookie. */
  readonly cookie: string;
}

export interface IdeUpstream {
  readonly kind: IdeServerKind;
  /** The cookie (`name=value`) the gateway adds to every upstream request and upgrade. */
  readonly cookie: string;
  /** The server serves at `/`: the gateway strips the base path (and redirects the bare base path to `base/`). */
  readonly stripBase: boolean;
  /** openvscode-server: HTML answers set the `vscode-tkn` cookie for the workbench's WebSocket handshake. */
  readonly browserTokenCookie: boolean;
}

export interface IdeLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  /** Files written (0600) before the launch: the secret's file / config. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Variables set for the server (over the inherited ones). */
  readonly env: Readonly<Record<string, string>>;
  /** Variables removed from the server's environment. */
  readonly dropEnv: readonly string[];
  readonly readiness: IdeReadiness;
  readonly upstream: IdeUpstream;
}

/** Variables code-server reads that would change its address, auth, gallery or proxy behind the worker's back. */
export const CODE_SERVER_DROP_ENV: readonly string[] = [
  'PORT',
  'CODE_SERVER_HOST',
  'PASSWORD',
  'HASHED_PASSWORD',
  'GITHUB_TOKEN',
  'CODE_SERVER_CONFIG',
  'CODE_SERVER_COOKIE_SUFFIX',
  'CODE_SERVER_SESSION_SOCKET',
  'CODE_SERVER_IDLE_TIMEOUT_SECONDS',
  'CODE_SERVER_RECONNECTION_GRACE_TIME',
  'CODE_SERVER_APP_NAME',
  'CODE_SERVER_PARENT_PID',
  'VSCODE_PROXY_URI',
  'VSCODE_OPTIONS',
  'VSCODE_IPC_HOOK_CLI',
];

/** A path behind code-server's auth (any path its VS Code router handles: `ensureAuthenticated` runs first). */
export const CODE_SERVER_AUTH_PROBE = '/remyral-auth-probe';

const TOKEN = /^[0-9A-Za-z_-]{16,128}$/;

export function ideLaunchPlan(i: IdeLaunchInput): IdeLaunchPlan {
  if (!TOKEN.test(i.token)) throw new RangeError('the IDE secret must be base64url');
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) throw new RangeError('bad port');
  if (i.install.kind === 'openvscode-server') {
    const tokenFile = join(i.dirs.run, 'connection-token');
    return {
      command: i.install.binary,
      args: [
        '--host',
        '127.0.0.1',
        '--port',
        String(i.port),
        '--connection-token-file',
        tokenFile,
        '--server-base-path',
        i.basePath,
        '--server-data-dir',
        i.dirs.serverData,
        '--user-data-dir',
        i.dirs.userData,
        '--extensions-dir',
        i.dirs.ext,
        '--default-folder',
        i.folder,
        '--telemetry-level',
        'off',
        '--accept-server-license-terms',
      ],
      files: [{ path: tokenFile, content: i.token }],
      env: {},
      dropEnv: [],
      readiness: {
        readyPath: `${i.basePath}/version`,
        anonymousPath: `${i.basePath}/`,
        anonymousStatus: [401, 403],
        cookie: `vscode-tkn=${i.token}`,
      },
      upstream: {
        kind: 'openvscode-server',
        cookie: `vscode-tkn=${i.token}`,
        stripBase: false,
        browserTokenCookie: true,
      },
    };
  }
  const config = join(i.dirs.run, 'code-server.yaml');
  const cookie = `code-server-session=${i.token}`;
  return {
    command: i.install.binary,
    args: [
      // The package directory: `lib/node <dir>` runs its `main` (out/node/entry.js), as bin/code-server(.cmd) does.
      i.install.dir,
      '--config',
      config,
      '--bind-addr',
      `127.0.0.1:${String(i.port)}`,
      '--auth',
      'password',
      '--user-data-dir',
      i.dirs.userData,
      '--extensions-dir',
      i.dirs.ext,
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-proxy',
      '--disable-getting-started-override',
      '--ignore-last-opened',
      // POSIX: its session socket inside the run dir (the sandbox allows Unix sockets only there). Windows: a named
      // pipe derived from the user data dir (code-server's default).
      ...(i.platform === 'win32' ? [] : ['--session-socket', join(i.dirs.run, 'cs.sock')]),
      '--',
      i.folder,
    ],
    files: [
      {
        path: config,
        // Double-quoted: a base64url value is never read as a number or a YAML indicator.
        content: `# Written by the Remyral worker for one IDE start (p19-ide W2b); replaced at every start.\nhashed-password: "${i.token}"\n`,
      },
    ],
    env: { EXTENSIONS_GALLERY: '{}' },
    dropEnv: CODE_SERVER_DROP_ENV,
    readiness: {
      readyPath: '/healthz',
      anonymousPath: CODE_SERVER_AUTH_PROBE,
      anonymousStatus: [401],
      authedPath: CODE_SERVER_AUTH_PROBE,
      cookie,
    },
    upstream: { kind: 'code-server', cookie, stripBase: true, browserTokenCookie: false },
  };
}
