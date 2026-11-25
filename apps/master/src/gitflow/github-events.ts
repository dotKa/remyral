import { SHA } from './refs.js';

/**
 * p22-github-webhook (docs/design/p22-github-webhook.md): what a verified GitHub App delivery says changed, in the terms
 * the merge-state refresh keys on — branches that moved, pull requests that changed, commits whose CI changed. Null:
 * the event changes nothing the git flow tracks. The payload is untrusted: only well-formed names, numbers and shas are
 * taken, and they are only compared against stored values (never used to reach GitHub).
 */
export interface GitHubEventTarget {
  readonly branches: readonly string[];
  readonly pullRequests: readonly number[];
  readonly shas: readonly string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const BRANCH = /^[^\s~^:?*[\\]{1,255}$/;
const branchOf = (ref: string): string | null => {
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return BRANCH.test(name) ? name : null;
};
const shaOf = (v: unknown): string | null => {
  const s = str(v).toLowerCase();
  return SHA.test(s) ? s : null;
};
const prOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31 ? v : null;

const some = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

export function gitHubEventTarget(event: string, payload: unknown): GitHubEventTarget | null {
  const p = obj(payload);
  let t: GitHubEventTarget;
  switch (event) {
    case 'push': {
      const ref = str(p.ref);
      // Tags do not move a branch the git flow tracks.
      if (!ref.startsWith('refs/heads/')) return null;
      t = { branches: some([branchOf(ref)]), pullRequests: [], shas: [] };
      break;
    }
    case 'pull_request': {
      const pr = obj(p.pull_request);
      t = {
        branches: some([branchOf(str(obj(pr.head).ref))]),
        pullRequests: some([prOf(p.number) ?? prOf(pr.number)]),
        shas: some([shaOf(obj(pr.head).sha)]),
      };
      break;
    }
    case 'check_suite':
      t = { branches: [], pullRequests: [], shas: some([shaOf(obj(p.check_suite).head_sha)]) };
      break;
    case 'check_run':
      t = { branches: [], pullRequests: [], shas: some([shaOf(obj(p.check_run).head_sha)]) };
      break;
    case 'status':
      t = { branches: [], pullRequests: [], shas: some([shaOf(p.sha)]) };
      break;
    default:
      return null;
  }
  return t.branches.length + t.pullRequests.length + t.shas.length === 0 ? null : t;
}
