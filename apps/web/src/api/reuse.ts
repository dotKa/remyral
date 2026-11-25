import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p6-result-reuse (docs/design/p6-result-reuse.md §4): "did an identical job finish recently?" before the composer
 * submits. Read-only on the master; the composer only offers the result ("Open result / Run anyway").
 */

export interface IdenticalResult {
  readonly jobId: string;
  readonly finishedAt: string;
  /** "2 h ago" (master wording). */
  readonly age: string;
  readonly runtime: string;
  readonly modelProfile: string | null;
  readonly baseCommit: string | null;
}

export interface ReuseCheck {
  readonly match: IdenticalResult | null;
  readonly reason: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

export function parseReuseCheck(v: unknown): ReuseCheck {
  const o = obj(v);
  const m = o.match === null || o.match === undefined ? null : obj(o.match);
  return {
    match:
      m === null
        ? null
        : {
            jobId: str(m, 'jobId'),
            finishedAt: str(m, 'finishedAt'),
            age: str(m, 'age'),
            runtime: str(m, 'runtime'),
            modelProfile: nullableStr(m, 'modelProfile'),
            baseCommit: nullableStr(m, 'baseCommit'),
          },
    reason: nullableStr(o, 'reason'),
  };
}

/** Hex sha256 of a base64 file body (what the master records as the input's digest). */
export async function sha256OfBase64(contentBase64: string): Promise<string> {
  const bin = atob(contentBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkReuse(
  body: {
    readonly project: string;
    readonly spec: Readonly<Record<string, unknown>>;
    readonly files?: readonly { readonly name: string; readonly contentBase64: string }[];
    readonly continueFrom?: string;
  },
  opts: Opts = {},
): Promise<ReuseCheck> {
  const inputs = await Promise.all(
    (body.files ?? []).map(async (f) => ({ name: f.name, sha256: await sha256OfBase64(f.contentBase64) })),
  );
  return apiRequest('POST', '/jobs/reuse-check', parseReuseCheck, {
    ...opts,
    body: {
      project: body.project,
      spec: body.spec,
      ...(inputs.length === 0 ? {} : { inputs }),
      ...(body.continueFrom === undefined ? {} : { continueFrom: body.continueFrom }),
    },
  });
}

/** p6-result-reuse: what "identical" meant for this offer, in plain words. */
export function identicalText(m: IdenticalResult): string {
  const same = [
    'project',
    `runtime ${m.runtime}`,
    ...(m.modelProfile === null ? [] : [`model ${m.modelProfile}`]),
    'prompt',
    m.baseCommit === null ? 'input files' : `base commit ${m.baseCommit.slice(0, 12)}`,
  ];
  return `Same ${same.join(', ')}. Open its result, or run this job anyway.`;
}
