import { describe, expect, it } from 'vitest';
import { composeServicesOf } from '../../src/ops/coolify.js';

describe('composeServicesOf (Docker Compose domains are per service)', () => {
  it('reads services and their domains from docker_compose_domains (a JSON string)', () => {
    const out = composeServicesOf({
      docker_compose_domains: JSON.stringify({
        web: { domain: 'https://a.example.com' },
        worker: { domain: '' },
      }),
    });
    expect(out.composeServices).toEqual(['web', 'worker']);
    expect(out.composeDomains).toEqual({ web: 'https://a.example.com', worker: '' });
  });

  it('falls back to the top-level services of the raw compose file', () => {
    const raw = 'services:\n  app:\n    image: node\n  db:\n    image: postgres\nvolumes:\n  data:\n';
    expect(composeServicesOf({ docker_compose_raw: raw }).composeServices).toEqual(['app', 'db']);
  });

  it('is empty for other applications and ignores malformed input', () => {
    expect(composeServicesOf({}).composeServices).toEqual([]);
    expect(composeServicesOf({ docker_compose_domains: '{not json' }).composeServices).toEqual([]);
    expect(
      composeServicesOf({ docker_compose_domains: JSON.stringify({ 'bad name!': {} }) }).composeServices,
    ).toEqual([]);
  });
});

describe('updateBody watch paths', () => {
  it('joins patterns with newlines and clears with null', async () => {
    const { updateBody } = await import('../../src/ops/coolify-apps.js');
    expect(updateBody({ watchPaths: ['apps/web/**', '!**/*.md'], deploy: false })).toEqual({
      watch_paths: 'apps/web/**\n!**/*.md',
    });
    expect(updateBody({ watchPaths: [], deploy: false })).toEqual({ watch_paths: null });
  });
});
