import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  AccessKeyId,
  BEDROCK_PANEL_MODELS,
  BEDROCK_PANEL_REGIONS,
  bedrockErrorHint,
  bedrockIamPolicy,
  LocalHashEmbedder,
  resolveProvider,
  SecretAccessKey,
} from '../../src/search/index.js';

/**
 * p10-bedrock-integration-panel (docs/design/p10-semantic-memory.md §11): the provider precedence between Settings →
 * Integrations → AWS Bedrock and SEARCH_PROVIDER, the IAM policy text, error hints and key formats.
 */

const envEmbedder = new LocalHashEmbedder(64);

describe('provider precedence (unit)', () => {
  it('SEARCH_PROVIDER=off is the kill switch: no provider whatever the panel says', () => {
    expect(resolveProvider({ mode: 'off', embedder: null, credentialSource: 'environment' }, 'none')).toEqual(
      { kind: 'none', source: null, panelInactiveReason: null },
    );
    const d = resolveProvider({ mode: 'off', embedder: null, credentialSource: 'environment' }, 'usable');
    expect(d.kind).toBe('none');
    expect(d.panelInactiveReason).toMatch(/SEARCH_PROVIDER=off/);
  });

  it('SEARCH_PROVIDER=http / local-hash takes precedence over the panel', () => {
    for (const mode of ['http', 'local-hash'] as const) {
      const d = resolveProvider({ mode, embedder: envEmbedder, credentialSource: 'environment' }, 'usable');
      expect(d).toMatchObject({ kind: 'env', source: 'environment' });
      expect(d.panelInactiveReason).toContain(`SEARCH_PROVIDER=${mode}`);
    }
  });

  it('a usable panel row wins over an unset or bedrock SEARCH_PROVIDER', () => {
    expect(
      resolveProvider({ mode: 'unset', embedder: null, credentialSource: 'environment' }, 'usable'),
    ).toEqual({ kind: 'panel', source: 'panel', panelInactiveReason: null });
    expect(
      resolveProvider(
        { mode: 'bedrock', embedder: envEmbedder, credentialSource: 'instance role' },
        'usable',
      ),
    ).toEqual({ kind: 'panel', source: 'panel', panelInactiveReason: null });
  });

  it('without a usable panel row, env Bedrock is the fallback (environment keys or instance role)', () => {
    expect(
      resolveProvider({ mode: 'bedrock', embedder: envEmbedder, credentialSource: 'instance role' }, 'none'),
    ).toEqual({ kind: 'env', source: 'instance role', panelInactiveReason: null });
    const d = resolveProvider(
      { mode: 'bedrock', embedder: envEmbedder, credentialSource: 'environment' },
      'unusable',
    );
    expect(d).toMatchObject({ kind: 'env', source: 'environment' });
    expect(d.panelInactiveReason).toMatch(/cannot be decrypted/);
    expect(
      resolveProvider({ mode: 'unset', embedder: null, credentialSource: 'environment' }, 'none'),
    ).toEqual({ kind: 'none', source: null, panelInactiveReason: null });
  });
});

describe('panel helpers (unit)', () => {
  it('the IAM policy allows only bedrock:InvokeModel on the selected model in the selected region', () => {
    expect(bedrockIamPolicy('eu-central-1', 'cohere.embed-v4:0')).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'RemyralEmbeddingsOnly',
          Effect: 'Allow',
          Action: 'bedrock:InvokeModel',
          Resource: 'arn:aws:bedrock:eu-central-1::foundation-model/cohere.embed-v4:0',
        },
      ],
    });
  });

  it('offers the three supported models, the default first, and the Cohere v3 regions', () => {
    expect([...BEDROCK_PANEL_MODELS]).toEqual([
      'cohere.embed-multilingual-v3',
      'cohere.embed-v4:0',
      'amazon.titan-embed-text-v2:0',
    ]);
    expect(BEDROCK_PANEL_REGIONS).toContain('us-east-1');
    expect(BEDROCK_PANEL_REGIONS).toContain('eu-central-1');
  });

  it('hints by AWS error type only', () => {
    expect(bedrockErrorHint('AccessDeniedException', 403)).toMatch(/IAM policy.*model access/);
    expect(bedrockErrorHint('UnrecognizedClientException', 403)).toMatch(/access key/);
    expect(bedrockErrorHint('ResourceNotFoundException', 404)).toMatch(/region/);
    expect(bedrockErrorHint('SomethingElse', 503)).toMatch(/server error/);
  });

  it('accepts long-term IAM user keys only', () => {
    expect(AccessKeyId.safeParse('AKIAIOSFODNN7EXAMPLE').success).toBe(true);
    expect(AccessKeyId.safeParse('ASIAIOSFODNN7EXAMPLE').success).toBe(false);
    expect(AccessKeyId.safeParse('akiaiosfodnn7example').success).toBe(false);
    expect(SecretAccessKey.safeParse('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').success).toBe(true);
    expect(SecretAccessKey.safeParse('short').success).toBe(false);
  });
});

describe('SEARCH_PROVIDER modes (unit)', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    TOTP_KEY_FILE: '/run/secrets/totp.key',
  };

  it('unset / none lets the panel decide; off is the kill switch; the indexer interval applies to both', () => {
    const unset = loadConfig(base);
    expect(unset.search).toBeNull();
    expect(unset.searchControl).toEqual({ mode: 'unset', intervalMs: 60_000 });
    expect(loadConfig({ ...base, SEARCH_PROVIDER: 'none' }).searchControl.mode).toBe('unset');
    const off = loadConfig({ ...base, SEARCH_PROVIDER: 'off', SEARCH_INDEX_INTERVAL_MS: '30000' });
    expect(off.search).toBeNull();
    expect(off.searchControl).toEqual({ mode: 'off', intervalMs: 30_000 });
    const bedrock = loadConfig({ ...base, SEARCH_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' });
    expect(bedrock.searchControl.mode).toBe('bedrock');
  });
});
