import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUNCTION_CODE_BASE_IMAGES } from '../src/function-job.js';

/** K3: the code node images are built FROM exactly the protocol's pinned digests (security:pins checks the digest). */
describe('code node base images', () => {
  const from = (dir: string): string[] =>
    readFileSync(
      fileURLToPath(new URL(`../../../infra/worker/images/${dir}/Dockerfile`, import.meta.url)),
      'utf8',
    )
      .split('\n')
      .filter((l) => /^FROM\s/.test(l))
      .map((l) => l.replace(/^FROM\s+/, '').trim());

  it('code-js is FROM FUNCTION_CODE_BASE_IMAGES.js', () => {
    expect(from('code-js')).toEqual([FUNCTION_CODE_BASE_IMAGES.js]);
  });

  it('code-python is FROM FUNCTION_CODE_BASE_IMAGES.python', () => {
    expect(from('code-python')).toEqual([FUNCTION_CODE_BASE_IMAGES.python]);
  });

  it('both are pinned by digest', () => {
    for (const ref of Object.values(FUNCTION_CODE_BASE_IMAGES)) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
