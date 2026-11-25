import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

/**
 * Dedicated low-privilege worker OS user (ADR-0007: mandatory for every host
 * profile on macOS, Windows and the Pi). The service is installed to run as that
 * user (p2-service-*); here the worker verifies it at start and refuses host
 * profiles otherwise.
 *
 * Unsafe identities:
 *  - root / SYSTEM, or a member of an administrators group (macOS `admin`,
 *    Linux `sudo`/`wheel`/`admin`/`root`, Windows BUILTIN\Administrators);
 *  - a member of a group that is root-equivalent (`docker`, `lxd`, `libvirt`,
 *    `disk`) — rootless engines do not need it;
 *  - the interactive owner of the machine (macOS console user);
 *  - any user other than the configured `sandbox.workerUser` (the operator names
 *    the dedicated user explicitly).
 *
 * p5-sandbox-ops: the installers write `sandbox.workerUser` (Windows `NT SERVICE\RemyralWorker`, Linux
 * `remyral-worker`, macOS `_remyralworker`). For installs that predate that, an unset name is **inferred** when the
 * worker runs as exactly the account its installer creates — on Windows proven by the token's user SID being the
 * service SID of `RemyralWorker` (a name alone could be any local account). The admin/SYSTEM/root/console checks
 * apply unchanged either way. On Windows a configured `NT SERVICE\<name>` is matched by SID as well.
 */

export interface IdentityFacts {
  readonly platform: NodeJS.Platform;
  readonly username: string;
  /** POSIX uid, `null` on Windows. */
  readonly uid: number | null;
  readonly groupNames: readonly string[];
  readonly groupIds: readonly number[];
  /** macOS: uid owning /dev/console (the logged-in GUI user); null if unknown/none. */
  readonly consoleUid: number | null;
  /** Windows: group SIDs of the process token. */
  readonly groupSids: readonly string[];
  /** Windows: the token's user SID (a service virtual account: `S-1-5-80-…`). */
  readonly userSid?: string | null;
}

export interface WorkerIdentity {
  readonly verified: boolean;
  readonly username: string;
  readonly uid: number | null;
  /** Why it is not verified (empty when verified). */
  readonly problems: readonly string[];
  /** The dedicated user the check used and where it came from (p5-sandbox-ops). */
  readonly expectedUser?: string;
  readonly expectedUserSource?: 'config' | 'inferred' | 'none';
  /** Windows: the token's user SID (per-attempt ACLs grant it). */
  readonly sid?: string | null;
  /** Machine-readable code of the first problem (`worker_user_unset`, `running_as_admin`, …). */
  readonly code?: string;
}

/** The accounts the installers create (infra/worker/<os>/install.*). */
export const INSTALLER_WORKER_USERS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  win32: 'NT SERVICE\\RemyralWorker',
  linux: 'remyral-worker',
  darwin: '_remyralworker',
};

/**
 * Service SID (`S-1-5-80-…`) of a Windows service name: SHA-1 of the upper-cased name in UTF-16LE as five
 * little-endian UInt32 — what `sc.exe showsid` prints (same algorithm as install.ps1 Get-RemyralServiceSid).
 */
export function windowsServiceSid(name: string): string {
  const hash = createHash('sha1').update(Buffer.from(name.toUpperCase(), 'utf16le')).digest();
  const parts: string[] = [];
  for (let i = 0; i < 20; i += 4) parts.push(String(hash.readUInt32LE(i)));
  return `S-1-5-80-${parts.join('-')}`;
}

/** The installer account this process runs as, or undefined (never guesses from a name on Windows). */
export function inferWorkerUser(facts: IdentityFacts): string | undefined {
  const installer = INSTALLER_WORKER_USERS[facts.platform];
  if (installer === undefined) return undefined;
  if (facts.platform === 'win32') {
    const name = installer.slice(installer.indexOf('\\') + 1);
    return facts.userSid != null && facts.userSid === windowsServiceSid(name) ? installer : undefined;
  }
  return facts.username === installer ? installer : undefined;
}

/** Windows: `NT SERVICE\X` / `DOMAIN\X` / `X` against the running account (by SID for virtual accounts). */
function sameWindowsUser(facts: IdentityFacts, expected: string): boolean {
  const slash = expected.lastIndexOf('\\');
  const domain = slash < 0 ? '' : expected.slice(0, slash).toUpperCase();
  const name = slash < 0 ? expected : expected.slice(slash + 1);
  if (domain === 'NT SERVICE' && facts.userSid != null) return facts.userSid === windowsServiceSid(name);
  return facts.username.toLowerCase() === name.toLowerCase();
}

const POSIX_ADMIN_GROUPS = new Set(['admin', 'sudo', 'wheel', 'root', 'docker', 'lxd', 'libvirt', 'disk']);
const DARWIN_ADMIN_GID = 80;
const WIN_ADMINISTRATORS = 'S-1-5-32-544';
const WIN_SYSTEM = 'S-1-5-18';

export function evaluateIdentity(facts: IdentityFacts, configuredUser: string | undefined): WorkerIdentity {
  const problems: string[] = [];
  const codes: string[] = [];
  const add = (code: string, text: string): void => {
    codes.push(code);
    problems.push(text);
  };
  const configured = configuredUser === undefined || configuredUser === '' ? undefined : configuredUser;
  const inferred = configured === undefined ? inferWorkerUser(facts) : undefined;
  const expectedUser = configured ?? inferred;
  const source = configured !== undefined ? 'config' : inferred !== undefined ? 'inferred' : 'none';
  if (expectedUser === undefined) {
    add(
      'worker_user_unset',
      'sandbox.workerUser is not configured and the worker does not run as the installer-created account',
    );
  } else if (
    facts.platform === 'win32'
      ? !sameWindowsUser(facts, expectedUser)
      : facts.username.toLowerCase() !== expectedUser.toLowerCase()
  ) {
    add(
      'worker_user_mismatch',
      `running as ${facts.username}, not the configured worker user ${expectedUser}`,
    );
  }
  if (facts.platform === 'win32') {
    if (facts.groupSids.includes(WIN_SYSTEM) || facts.userSid === WIN_SYSTEM) {
      add('running_as_system', 'running as LocalSystem');
    }
    if (facts.groupSids.includes(WIN_ADMINISTRATORS)) {
      add('running_as_admin', 'member of BUILTIN\\Administrators');
    }
  } else {
    if (facts.uid === 0) add('running_as_root', 'running as root');
    const bad = facts.groupNames.filter((g) => POSIX_ADMIN_GROUPS.has(g));
    if (facts.platform === 'darwin' && facts.groupIds.includes(DARWIN_ADMIN_GID) && !bad.includes('admin')) {
      bad.push('admin');
    }
    if (bad.length > 0) add('privileged_group', `member of privileged group(s): ${bad.join(', ')}`);
    if (facts.platform === 'darwin' && facts.consoleUid !== null && facts.consoleUid === facts.uid) {
      add('console_user', 'is the interactive console user (the machine owner), not a dedicated worker user');
    }
  }
  return {
    verified: problems.length === 0,
    username: facts.username,
    uid: facts.uid,
    problems,
    ...(expectedUser === undefined ? {} : { expectedUser }),
    expectedUserSource: source,
    sid: facts.userSid ?? null,
    ...(codes[0] === undefined ? {} : { code: codes[0] }),
  };
}

type Run = (cmd: string, args: readonly string[]) => Promise<string>;

/**
 * Windows: `whoami` by absolute path. With the POSIX-only PATH below libuv found no `whoami` at all, the facts
 * came back empty and an Administrators member was not recognised — found on a real Windows 11 (p5-sandbox-ops).
 */
function resolveTool(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return `${root}\\System32\\${cmd}.exe`;
}

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot ?? '';
    execFile(
      resolveTool(cmd),
      [...args],
      {
        timeout: 10_000,
        windowsHide: true,
        env:
          process.platform === 'win32'
            ? { PATH: `${systemRoot}\\System32`, SystemRoot: systemRoot }
            : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SystemRoot: systemRoot },
      },
      (err, stdout) => {
        if (err) reject(new Error(err.message));
        else resolve(stdout);
      },
    );
  });

/** Collects identity facts from the OS (no secrets involved). */
export async function collectIdentityFacts(
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Promise<IdentityFacts> {
  const info = userInfo();
  if (platform === 'win32') {
    // CSV rows: "Group Name","Type","SID","Attributes"
    const out = await exec('whoami', ['/groups', '/fo', 'csv', '/nh']).catch(() => '');
    const sids = [...out.matchAll(/"(S-1-[0-9-]+)"/g)].map((m) => m[1] ?? '');
    const user = await exec('whoami', ['/user', '/fo', 'csv', '/nh']).catch(() => '');
    const userSid = /"(S-1-[0-9-]+)"/.exec(user)?.[1];
    return {
      platform,
      username: info.username,
      uid: null,
      groupNames: [],
      groupIds: [],
      consoleUid: null,
      groupSids: userSid === undefined ? sids : [...sids, userSid],
      userSid: userSid ?? null,
    };
  }
  const names = (await exec('id', ['-Gn']).catch(() => '')).trim().split(/\s+/).filter(Boolean);
  const ids = (await exec('id', ['-G']).catch(() => ''))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
  let consoleUid: number | null = null;
  if (platform === 'darwin') {
    const out = await exec('stat', ['-f', '%u', '/dev/console']).catch(() => '');
    const n = Number(out.trim());
    consoleUid = out.trim() !== '' && Number.isInteger(n) ? n : null;
  }
  return {
    platform,
    username: info.username,
    uid: info.uid,
    groupNames: names,
    groupIds: ids,
    consoleUid,
    groupSids: [],
  };
}

export async function verifyWorkerIdentity(opts: {
  expectedUser?: string | undefined;
  platform?: NodeJS.Platform;
  facts?: IdentityFacts;
}): Promise<WorkerIdentity> {
  const facts = opts.facts ?? (await collectIdentityFacts(opts.platform));
  return evaluateIdentity(facts, opts.expectedUser);
}
