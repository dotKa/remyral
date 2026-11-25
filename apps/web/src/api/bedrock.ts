import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p10-bedrock-integration-panel (apps/master/src/search/bedrock-routes.ts): Settings → Integrations → AWS Bedrock
 * (embeddings). The access keys are write-only: no response carries one; the browser only sends keys the admin types.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;

export type ProviderSource = 'panel' | 'environment' | 'instance role';
export type SearchEnvMode = 'unset' | 'off' | 'bedrock' | 'http' | 'local-hash';

export interface BedrockIntegration {
  readonly settings: { readonly region: string; readonly model: string };
  readonly keyIdHint: string;
  readonly keyFingerprint: string;
  readonly usable: boolean;
  readonly lastTest: Json | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
}

export interface BedrockStatus {
  readonly integration: BedrockIntegration | null;
  readonly active: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly region: string | null;
    readonly source: ProviderSource | null;
    readonly panelInUse: boolean;
    readonly panelInactiveReason: string | null;
  };
  readonly env: { readonly searchProvider: SearchEnvMode; readonly region: string | null };
  readonly options: {
    readonly regions: readonly string[];
    readonly models: readonly string[];
    readonly defaultModel: string;
  };
}

const SOURCES: readonly ProviderSource[] = ['panel', 'environment', 'instance role'];
const MODES: readonly SearchEnvMode[] = ['unset', 'off', 'bedrock', 'http', 'local-hash'];

export function parseSource(v: unknown): ProviderSource | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && (SOURCES as readonly string[]).includes(v)) return v as ProviderSource;
  throw new ShapeError('source');
}

function json(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

export function parseBedrockIntegration(v: unknown): BedrockIntegration | null {
  if (v === null) return null;
  const o = obj(v);
  const settings = obj(o.settings);
  if (typeof o.usable !== 'boolean') throw new ShapeError('usable');
  return {
    settings: { region: str(settings, 'region'), model: str(settings, 'model') },
    keyIdHint: str(o, 'keyIdHint'),
    keyFingerprint: str(o, 'keyFingerprint'),
    usable: o.usable,
    lastTest: o.lastTest === null ? null : json(o.lastTest),
    lastTestAt: nullableStr(o, 'lastTestAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function parseBedrockStatus(v: unknown): BedrockStatus {
  const o = obj(v);
  const active = obj(o.active);
  const env = obj(o.env);
  const options = obj(o.options);
  const mode = str(env, 'searchProvider');
  if (!(MODES as readonly string[]).includes(mode)) throw new ShapeError('searchProvider');
  if (typeof active.panelInUse !== 'boolean') throw new ShapeError('panelInUse');
  return {
    integration: parseBedrockIntegration(o.integration),
    active: {
      provider: nullableStr(active, 'provider'),
      model: nullableStr(active, 'model'),
      region: nullableStr(active, 'region'),
      source: parseSource(active.source),
      panelInUse: active.panelInUse,
      panelInactiveReason: nullableStr(active, 'panelInactiveReason'),
    },
    env: { searchProvider: mode as SearchEnvMode, region: nullableStr(env, 'region') },
    options: {
      regions: strArray(options, 'regions'),
      models: strArray(options, 'models'),
      defaultModel: str(options, 'defaultModel'),
    },
  };
}

export function getBedrock(opts: Opts = {}): Promise<BedrockStatus> {
  return apiRequest('GET', '/integrations/bedrock', parseBedrockStatus, opts);
}

export function saveBedrock(
  body: {
    readonly region: string;
    readonly model: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  },
  opts: Opts = {},
): Promise<BedrockIntegration | null> {
  return apiRequest('PUT', '/integrations/bedrock', parseBedrockIntegration, { ...opts, body });
}

export function removeBedrock(opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', '/integrations/bedrock', () => undefined, opts);
}

export function testBedrock(opts: Opts = {}): Promise<Json> {
  return apiRequest('POST', '/integrations/bedrock/test', json, opts);
}

/** The least-privilege IAM policy for a region + model (same text as the master and the canvas note). */
export function bedrockIamPolicy(region: string, model: string): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'RemyralEmbeddingsOnly',
          Effect: 'Allow',
          Action: 'bedrock:InvokeModel',
          Resource: `arn:aws:bedrock:${region}::foundation-model/${model}`,
        },
      ],
    },
    null,
    2,
  );
}

export const MODEL_LABELS: Readonly<Record<string, string>> = {
  'cohere.embed-multilingual-v3':
    'Cohere Embed Multilingual v3 (default, Turkish + 100 languages, 1024 dims)',
  'cohere.embed-v4:0': 'Cohere Embed v4 (1536 dims; Turkish quality unverified)',
  'amazon.titan-embed-text-v2:0': 'Amazon Titan Text Embeddings V2 (1024 dims)',
};

export const SOURCE_TEXT: Readonly<Record<ProviderSource, string>> = {
  panel: 'panel (Settings → Integrations)',
  environment: 'environment (stack.env)',
  'instance role': 'instance role (AWS SDK default chain)',
};
