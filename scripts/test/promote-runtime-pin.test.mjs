// p16-runtime-updates: the promotion of a verified runtime candidate into the release pins rewrites exactly the
// mechanical sources `pnpm security:pins` checks (offline against this checkout; nothing is written here).
import { describe, expect, it } from 'vitest';
import { RUNTIME_PINS } from '../../packages/protocol/src/runtime-pins.ts';
import { readJson, readText } from '../security/lib.mjs';
import { checkPins } from '../security/runtime-pins.mjs';
import { checkLock, planPromotion, PromoteError, sdkVersionFor } from '../release/promote-runtime-pin.mjs';

const OLD = RUNTIME_PINS.codex.version;
const NEXT = '0.999.0';
const SRI = `sha512-${'Q'.repeat(86)}==`;

/** The current codex image lock moved to NEXT (what the console's lock download looks like). */
function nextLock() {
  const lock = JSON.parse(JSON.stringify(readJson('infra/worker/images/codex/package-lock.json')));
  lock.packages[''].dependencies['@openai/codex'] = NEXT;
  const top = lock.packages['node_modules/@openai/codex'];
  top.version = NEXT;
  top.resolved = `https://registry.npmjs.org/@openai/codex/-/codex-${NEXT}.tgz`;
  top.integrity = SRI;
  return lock;
}

describe('promote-runtime-pin', () => {
  it('rewrites every pin source so the pin check passes with the new version', () => {
    const plan = planPromotion({ runtime: 'codex', version: NEXT, lock: nextLock(), pins: RUNTIME_PINS });
    const read = (rel) => plan.files.get(rel) ?? readText(rel);
    const readJ = (rel) => JSON.parse(read(rel));
    const pins = {
      ...RUNTIME_PINS,
      codex: {
        ...RUNTIME_PINS.codex,
        version: NEXT,
        packageVersion: NEXT,
        install: `npm: @openai/codex@${NEXT}`,
      },
    };
    const checksums = readJ('infra/worker/images/runtime-checksums.json');
    expect(checksums.codex).toEqual({
      version: NEXT,
      npm: { name: '@openai/codex', version: NEXT, integrity: SRI },
    });
    expect(checkPins({ pins, checksums, read, readJ })).toEqual([]);
    expect(read('packages/protocol/src/runtime-pins.ts')).toContain(`install: 'npm: @openai/codex@${NEXT}'`);
    expect(read('infra/worker/runtimes/codex/previous/version.txt')).toBe(`${OLD}\n`);
    expect(read('infra/worker/runtimes/codex/previous/package-lock.json')).toBe(
      readText('infra/worker/images/codex/package-lock.json'),
    );
    // What a script must not do is listed for a person.
    expect(plan.human.some((h) => h.includes('worker release'))).toBe(true);
    expect(plan.human.some((h) => h.includes('ADR-0012'))).toBe(true);
  });

  it('refuses a lock that is not exactly the release, and the current pin', () => {
    const wrongRoot = nextLock();
    wrongRoot.packages[''].dependencies['@openai/codex'] = '0.998.0';
    expect(() => checkLock(wrongRoot, 'codex', '@openai/codex', NEXT)).toThrow(PromoteError);
    const git = nextLock();
    git.packages['node_modules/@openai/codex'].resolved = 'git+https://example.com/codex.git';
    expect(() => checkLock(git, 'codex', '@openai/codex', NEXT)).toThrow(/registry/);
    expect(() =>
      planPromotion({ runtime: 'codex', version: OLD, lock: nextLock(), pins: RUNTIME_PINS }),
    ).toThrow(/already the pin/);
  });

  it('Claude Code: the SDK version follows the pinned line; another line is refused', () => {
    const pin = RUNTIME_PINS['claude-code'];
    const [maj, min] = pin.version.split('.');
    expect(sdkVersionFor(pin, `${maj}.${min}.309`)).toBe(
      `${pin.packageVersion.split('.').slice(0, 2).join('.')}.309`,
    );
    expect(sdkVersionFor(pin, `${maj}.${Number(min) + 1}.0`)).toBeNull();
  });
});
