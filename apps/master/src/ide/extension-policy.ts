import {
  IDE_EXTENSION_LIMITS,
  type IdeExtensionRef,
  type IdeProfile,
  type IdeTargetPlatform,
} from '@remyral/protocol';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4, decision 4): which extensions a workspace start installs. Pure.
 *
 * Layers (most specific wins, **deny always wins**):
 *  - global (admin): the allowlist (one approved, cached version per extension), a deny list, "verified publishers
 *    only";
 *  - project (admin): `required` (installed at every start; the user cannot remove them), `recommended` (offered to the
 *    user), a project deny list, enforced settings;
 *  - user: their own list, chosen from what the two layers above allow.
 *
 * Installed = (required ∪ the user's list) ∩ allowed, plus the allowed dependencies / pack members of those (one level
 * at a time, until nothing new). A dependency that is not allowed is reported and not installed (VS Code then shows
 * the dependent extension as needing it). Each extension needs a cached build for the machine: `universal`, else the
 * machine's target (W3: Linux; W2b: also `darwin-x64|arm64`, `win32-x64`). `extensions.allowed` lists exactly the installed ids (the worker adds the bridge).
 */

export interface AllowlistEntry {
  readonly id: string;
  readonly version: string;
  readonly publisherVerified: boolean;
  readonly dependencies: readonly string[];
  readonly blobs: readonly {
    readonly target: IdeTargetPlatform;
    readonly sha256: string;
    readonly size: number;
  }[];
}

export interface PolicyInput {
  readonly allowlist: readonly AllowlistEntry[];
  readonly global: { readonly verifiedOnly: boolean; readonly deny: readonly string[] };
  readonly project: {
    readonly required: readonly string[];
    readonly deny: readonly string[];
    readonly enforcedSettings: Readonly<Record<string, unknown>>;
  } | null;
  readonly user: readonly string[];
  /** The machine's VS Code target (null: unknown — only `universal` builds fit). */
  readonly target: IdeTargetPlatform | null;
  readonly settingsSync: boolean;
}

export type SkipReason =
  'not_allowed' | 'denied' | 'unverified' | 'no_build' | 'dependency_not_allowed' | 'limit';

export interface ResolvedProfile {
  readonly profile: IdeProfile;
  readonly skipped: readonly { readonly id: string; readonly reason: SkipReason }[];
}

/** Why an extension may not be used in a project (null: it may). */
export function denial(
  id: string,
  input: Pick<PolicyInput, 'allowlist' | 'global' | 'project'>,
): Exclude<SkipReason, 'no_build' | 'dependency_not_allowed' | 'limit'> | null {
  if (input.global.deny.includes(id) || (input.project?.deny.includes(id) ?? false)) return 'denied';
  const entry = input.allowlist.find((e) => e.id === id);
  if (entry === undefined) return 'not_allowed';
  if (input.global.verifiedOnly && !entry.publisherVerified) return 'unverified';
  return null;
}

/**
 * A machine's OS (`process.platform`, null: unknown → Linux as in W3) and Node `process.arch` → its VS Code target
 * (null: none — only `universal` builds fit). W2b adds macOS (`darwin-x64|arm64`) and Windows (`win32-x64`).
 */
export function ideTarget(os: string | null, arch: string | null): IdeTargetPlatform | null {
  if (os === null || os === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
    if (arch === 'arm') return 'linux-armhf';
    return null;
  }
  if (os === 'darwin') {
    if (arch === 'x64') return 'darwin-x64';
    if (arch === 'arm64') return 'darwin-arm64';
    return null;
  }
  if (os === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

export function resolveProfile(input: PolicyInput): ResolvedProfile {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const skip = (id: string, reason: SkipReason): void => {
    if (!skipped.some((s) => s.id === id)) skipped.push({ id, reason });
  };
  const chosen: IdeExtensionRef[] = [];
  const seen = new Set<string>();
  const queue: { id: string; dependency: boolean }[] = [
    ...(input.project?.required ?? []).map((id) => ({ id, dependency: false })),
    ...input.user.map((id) => ({ id, dependency: false })),
  ];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { id } = next;
    if (seen.has(id)) continue;
    seen.add(id);
    const why = denial(id, input);
    if (why !== null) {
      skip(id, next.dependency ? 'dependency_not_allowed' : why);
      continue;
    }
    const entry = input.allowlist.find((e) => e.id === id);
    if (entry === undefined) continue;
    const blob =
      entry.blobs.find((b) => b.target === 'universal') ??
      (input.target === null ? undefined : entry.blobs.find((b) => b.target === input.target));
    if (blob === undefined) {
      skip(id, 'no_build');
      continue;
    }
    if (chosen.length >= IDE_EXTENSION_LIMITS.perWorkspace) {
      skip(id, 'limit');
      continue;
    }
    chosen.push({
      id,
      version: entry.version,
      targetPlatform: blob.target,
      sha256: blob.sha256,
      size: blob.size,
    });
    for (const dep of entry.dependencies) queue.push({ id: dep, dependency: true });
  }
  return {
    profile: {
      extensions: chosen,
      allowed: chosen.map((e) => e.id),
      enforcedSettings: { ...(input.project?.enforcedSettings ?? {}) },
      settingsSync: input.settingsSync,
    },
    skipped,
  };
}

/**
 * A settings file the bridge wants to save: ≤ 256 KiB and no secret-looking value. `detect` is the chat's secret
 * detector (protocol `detectSecrets`); the answer names the first finding's kind, never its value.
 */
export function checkSettingsText(
  content: string,
  detect: (text: string) => readonly { readonly provider: string }[],
): { ok: true } | { ok: false; reason: 'too_large' | 'secret'; provider?: string } {
  if (Buffer.byteLength(content, 'utf8') > IDE_EXTENSION_LIMITS.settingsMaxBytes)
    return { ok: false, reason: 'too_large' };
  const found = detect(content);
  const first = found[0];
  if (first !== undefined) return { ok: false, reason: 'secret', provider: first.provider };
  return { ok: true };
}
