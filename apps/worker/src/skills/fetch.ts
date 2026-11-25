import type { DeliveredSkill } from '@remyral/agent-adapters';
import { completeDeferredSkill, type DeferredSkillCheck } from './verify.js';

/**
 * p14-skill-catalogs (`skills-layout-v2`): pulls the files of the job's deferred skills from the master over the
 * worker's authenticated session (SKILL_FILE_REQUEST → SKILL_FILE_DATA, control messages), by the signed manifest's
 * SHA-256 and the file's path, slice by slice. Nothing the master answers is trusted: a slice that would make a file
 * longer than the manifest says, a refusal, a timeout or any mismatch in the final full verification fails the job
 * (`skill_fetch_failed` / `skill_verification_failed`) before anything is materialised.
 */
export type SkillSliceAnswer =
  | { readonly status: 'ok'; readonly data: Buffer; readonly eof: boolean }
  | { readonly status: 'refused' | 'not_found' | 'timeout' };

export type SkillSliceRequest = (
  manifestSha256: string,
  path: string,
  offset: number,
) => Promise<SkillSliceAnswer>;

export class SkillFetchError extends Error {
  override name = 'SkillFetchError';
}

/** Files fetched at the same time (each is at most a few slices; keeps the session responsive). */
const PARALLEL_FILES = 4;

export async function fetchDeferredSkills(
  deferred: readonly DeferredSkillCheck[],
  request: SkillSliceRequest,
): Promise<DeliveredSkill[]> {
  const out: DeliveredSkill[] = [];
  for (const skill of deferred) {
    const files: Record<string, string> = {};
    const queue = [...skill.manifest.files];
    const worker = async (): Promise<void> => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
        files[f.path] = await fetchFile(skill, f.path, f.size, request);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_FILES, queue.length) }, () => worker()));
    const done = completeDeferredSkill(skill, files);
    if (!done.ok) throw new SkillFetchError(done.message);
    out.push(done.skill);
  }
  return out;
}

async function fetchFile(
  skill: DeferredSkillCheck,
  path: string,
  size: number,
  request: SkillSliceRequest,
): Promise<string> {
  const chunks: Buffer[] = [];
  let offset = 0;
  // A file of `size` bytes needs at most size / slice + 1 answers; a master that never says eof cannot loop us.
  for (let round = 0; round < 64; round++) {
    const answer = await request(skill.manifestSha256, path, offset);
    if (answer.status !== 'ok') {
      throw new SkillFetchError(
        `skill_fetch_failed: ${skill.manifest.id}@${skill.manifest.version} ${path}: ${answer.status}`,
      );
    }
    offset += answer.data.length;
    if (offset > size) {
      throw new SkillFetchError(
        `skill_fetch_failed: ${skill.manifest.id}@${skill.manifest.version} ${path}: longer than its manifest entry`,
      );
    }
    chunks.push(answer.data);
    if (answer.eof) return Buffer.concat(chunks).toString('utf8');
    if (answer.data.length === 0) break;
  }
  throw new SkillFetchError(
    `skill_fetch_failed: ${skill.manifest.id}@${skill.manifest.version} ${path}: incomplete`,
  );
}
