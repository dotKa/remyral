import type { DeliveredSkill } from '@remyral/agent-adapters';
import {
  type AssignedSkills,
  MAX_JOB_SKILL_BYTES_V2,
  type RuntimeKind,
  type SkillManifest,
  type SkillPin,
  type SkillSignature,
  skillKeyId,
  skillSetHash,
  verifySkillBundle,
} from '@remyral/protocol';

/**
 * p6-skills (docs/design/p6-skills.md §5): the worker's own verification of the skills that came with an
 * ASSIGN_JOB, against the skills keys of **its** config (root-owned) — not against anything the master says.
 * A master that is compromised, or a tampered outbox row, cannot make a worker run an unsigned skill.
 *
 * Fails closed: any bad signature, file hash, duplicate id, runtime mismatch or set-hash mismatch refuses the
 * whole job (the worker declines it before anything is prepared).
 *
 * p14-skill-catalogs (`skills-layout-v2`): layout-v2 manifests (`schema: 2`) are accepted, and skills may arrive
 * **deferred** — only the signed manifest is in ASSIGN_JOB. Their signature, manifest, runtime, trust and the job's set
 * hash are checked here at admission; the files are pulled afterwards (SKILL_FILE_REQUEST) and the assembled bundle is
 * verified again in full by {@link completeDeferredSkill} before anything is materialised.
 */
export type SkillCheck =
  | {
      readonly ok: true;
      readonly skills: readonly DeliveredSkill[];
      /** Skills whose files still have to be fetched (in the job's skill order after `skills`). */
      readonly deferred: readonly DeferredSkillCheck[];
      readonly setHash: string | null;
    }
  | { readonly ok: false; readonly message: string };

/** A deferred skill whose signed manifest verified at admission. */
export interface DeferredSkillCheck {
  readonly manifest: SkillManifest;
  readonly manifestB64: string;
  readonly signature: SkillSignature;
  readonly manifestSha256: string;
  /** The keys the manifest verified with (the trust decision of admission is kept for the file check). */
  readonly trustedKeys: readonly string[];
}

/**
 * p14-skill-import (ADR-0054): with `offlineOnly` (ASSIGN_JOB `execution.skillTrust: "offline-only"`) the panel skills
 * keys of the managed configuration do not count — a panel-signed (imported / chat-written) version declines the job.
 */
export interface SkillTrustOptions {
  readonly offlineOnly?: boolean;
  /** The panel skills keys of the applied, signed configuration (excluded when `offlineOnly`). */
  readonly panelKeys?: readonly string[];
  /** p14-skill-catalogs: this worker understands layout v2 and deferred skills (default true). */
  readonly layoutV2?: boolean;
}

export function verifyAssignedSkills(
  assigned: AssignedSkills | undefined,
  runtime: RuntimeKind,
  allKeys: readonly string[] | null,
  trust: SkillTrustOptions = {},
): SkillCheck {
  if (assigned === undefined) return { ok: true, skills: [], deferred: [], setHash: null };
  const layoutV2 = trust.layoutV2 !== false;
  const deferredIn = assigned.deferred ?? [];
  if (!layoutV2 && deferredIn.length > 0) {
    return { ok: false, message: 'skill_verification_failed: deferred skills need skills-layout-v2' };
  }
  const panel = trust.panelKeys ?? [];
  const local = allKeys ?? [];
  const panelIds = keyIds(panel);
  // `allKeys` is the union of the local file's offline keys and the panel keys: offline-only drops the panel ones.
  const trustedKeys = trust.offlineOnly === true ? local.filter((k) => !panel.includes(k)) : local;
  if (trust.offlineOnly === true) {
    const offlineIds = keyIds(trustedKeys);
    for (const sig of [...assigned.bundles, ...deferredIn].map((b) => b.signature)) {
      if (panelIds.has(sig.keyId) && !offlineIds.has(sig.keyId)) {
        return {
          ok: false,
          message:
            'skill_trust_refused: the project accepts only offline-signed skills, but a skill of this job is panel-signed',
        };
      }
    }
  }
  if (trustedKeys.length === 0) {
    return {
      ok: false,
      message:
        trust.offlineOnly === true
          ? 'skills_untrusted: the project accepts only offline-signed skills, but this worker has no offline skills.publicKeys configured'
          : 'skills_untrusted: the job carries skills but this worker has no skills.publicKeys configured',
    };
  }
  const skills: DeliveredSkill[] = [];
  const deferred: DeferredSkillCheck[] = [];
  const pins: SkillPin[] = [];
  let bytes = 0;
  const admit = (m: SkillManifest, manifestSha256: string): string | null => {
    if (pins.some((p) => p.id === m.id)) return `skill_verification_failed: duplicate skill ${m.id}`;
    if (!m.runtimes.includes(runtime)) {
      return `skill_verification_failed: ${m.id}@${m.version} is not for runtime ${runtime}`;
    }
    pins.push({ id: m.id, version: m.version, manifestSha256 });
    bytes += m.files.reduce((n, f) => n + f.size, 0);
    return null;
  };
  for (const bundle of assigned.bundles) {
    const v = verifySkillBundle(bundle, trustedKeys, { layoutV2 });
    if (!v.ok) return refused(v.reason, v.detail);
    const m = v.manifest;
    const problem = admit(m, v.manifestSha256);
    if (problem !== null) return { ok: false, message: problem };
    skills.push(delivered(m, bundle.files));
  }
  for (const ref of deferredIn) {
    const v = verifySkillBundle(ref, trustedKeys, { layoutV2, manifestOnly: true });
    if (!v.ok) return refused(v.reason, v.detail);
    const problem = admit(v.manifest, v.manifestSha256);
    if (problem !== null) return { ok: false, message: problem };
    deferred.push({
      manifest: v.manifest,
      manifestB64: ref.manifest,
      signature: ref.signature,
      manifestSha256: v.manifestSha256,
      trustedKeys,
    });
  }
  if (bytes > MAX_JOB_SKILL_BYTES_V2) {
    return {
      ok: false,
      message: `skill_verification_failed: the job's skills total ${String(bytes)} bytes (limit ${String(MAX_JOB_SKILL_BYTES_V2)})`,
    };
  }
  const setHash = skillSetHash(pins);
  if (setHash !== assigned.setHash) {
    return { ok: false, message: 'skill_verification_failed: the skill set does not match its pinned hash' };
  }
  return { ok: true, skills, deferred, setHash };
}

/**
 * p14-skill-catalogs: the files of a deferred skill arrived (SKILL_FILE_DATA). The whole bundle is verified again —
 * signature, manifest, the exact file set, every file's size and SHA-256 — and must be the manifest admission pinned.
 */
export function completeDeferredSkill(
  skill: DeferredSkillCheck,
  files: Readonly<Record<string, string>>,
): { readonly ok: true; readonly skill: DeliveredSkill } | { readonly ok: false; readonly message: string } {
  const v = verifySkillBundle(
    { manifest: skill.manifestB64, signature: skill.signature, files },
    skill.trustedKeys,
    { layoutV2: true },
  );
  if (!v.ok) return refused(v.reason, v.detail);
  if (v.manifestSha256 !== skill.manifestSha256) {
    return { ok: false, message: 'skill_verification_failed: the manifest changed while fetching' };
  }
  return { ok: true, skill: delivered(v.manifest, files) };
}

function delivered(m: SkillManifest, files: Readonly<Record<string, string>>): DeliveredSkill {
  return {
    id: m.id,
    version: m.version,
    title: m.title,
    description: m.description,
    files: m.files.map((f) => ({ path: f.path, executable: f.executable, content: files[f.path] ?? '' })),
  };
}

function refused(reason: string, detail: string | undefined): { ok: false; message: string } {
  return {
    ok: false,
    message: `skill_verification_failed: ${reason}${detail === undefined ? '' : ` (${detail.slice(0, 200)})`}`,
  };
}

function keyIds(keys: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const k of keys) {
    try {
      out.add(skillKeyId(k));
    } catch {
      // not a valid key: verifySkillBundle ignores it as well
    }
  }
  return out;
}
