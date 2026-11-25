import { describe, expect, it } from 'vitest';
import {
  AssignedPreviews,
  PreviewOp,
  PreviewRequestPayload,
  SITE_PUBLISH_FEATURE,
  WorkerFeature,
  WorkerFeatureList,
} from '../src/index.js';

/** p10-publish-bundle (ADR-0038): `publish_site` over the preview channel. */
describe('preview channel: publish op', () => {
  it('parses a publish op with every optional field, and refuses unknown or malformed ones', () => {
    expect(PreviewOp.parse({ kind: 'publish' })).toEqual({ kind: 'publish' });
    const full = {
      kind: 'publish',
      env: 'production',
      pagesProject: 'my-site',
      createIfMissing: true,
      domain: 'site.demo.test',
      dns: 'skip',
      directory: 'dist',
    };
    expect(PreviewOp.parse(full)).toEqual(full);
    for (const bad of [
      { kind: 'publish', env: 'staging' },
      { kind: 'publish', pagesProject: 'Bad_Name' },
      { kind: 'publish', pagesProject: '-x' },
      { kind: 'publish', dns: 'maybe' },
      { kind: 'publish', directory: '../up' },
      { kind: 'publish', domain: 'x' },
      { kind: 'publish', token: 'secret' },
    ]) {
      expect(PreviewOp.safeParse(bad).success).toBe(false);
    }
    expect(
      PreviewRequestPayload.safeParse({
        attemptId: 'att-1',
        epoch: 2,
        requestId: '6f1d3c2a-6b7e-4c1d-9a7e-2b1c3d4e5f60',
        op: { kind: 'publish', env: 'preview' },
      }).success,
    ).toBe(true);
  });

  it('AssignedPreviews.publish is optional (older masters omit it) and the feature is known', () => {
    expect(
      AssignedPreviews.parse({ tools: false, declaredPorts: [], protections: ['none'], publish: true })
        .publish,
    ).toBe(true);
    expect(
      AssignedPreviews.parse({ tools: true, declaredPorts: [], protections: ['none'] }).publish,
    ).toBeUndefined();
    expect(SITE_PUBLISH_FEATURE).toBe('site-publish-v1');
    expect(WorkerFeature.parse(SITE_PUBLISH_FEATURE)).toBe('site-publish-v1');
    expect(WorkerFeatureList.parse(['preview-tunnels-v1', 'site-publish-v1'])).toHaveLength(2);
  });
});
