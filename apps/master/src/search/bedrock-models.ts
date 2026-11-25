/**
 * p10-semantic-memory: the Amazon Bedrock embedding models the master supports (pure data, no SDK import, so the
 * config loader can validate without loading the AWS SDK). Shapes: see bedrock.ts and
 * docs/design/p10-semantic-memory.md §3.
 */

export type BedrockFamily = 'cohere-v3' | 'cohere-v4' | 'titan-v2';

export interface BedrockModelSpec {
  readonly family: BedrockFamily;
  /** Allowed output dimensions; the first is the default. */
  readonly dims: readonly number[];
  readonly maxBatch: number;
  readonly maxChars: number;
}

const COHERE_V3: BedrockModelSpec = { family: 'cohere-v3', dims: [1024], maxBatch: 96, maxChars: 2048 };
const COHERE_V4: BedrockModelSpec = {
  family: 'cohere-v4',
  dims: [1536, 1024, 512, 256],
  maxBatch: 96,
  maxChars: 8000,
};
const TITAN_V2: BedrockModelSpec = {
  family: 'titan-v2',
  dims: [1024, 512, 256],
  maxBatch: 1,
  maxChars: 8000,
};

/** The default model (by design): Cohere Embed Multilingual v3 — 100+ languages incl. Turkish, 1024 dims. */
export const DEFAULT_BEDROCK_MODEL = 'cohere.embed-multilingual-v3';

/** The supported Bedrock embedding model ids; anything else is refused at startup. */
export function bedrockModelSpec(modelId: string): BedrockModelSpec | null {
  if (modelId === 'cohere.embed-multilingual-v3') return COHERE_V3;
  if (/^(?:(?:us|eu|apac|global)\.)?cohere\.embed-v4:0$/.test(modelId)) return COHERE_V4;
  if (modelId === 'amazon.titan-embed-text-v2:0') return TITAN_V2;
  return null;
}

export const BEDROCK_MODEL_IDS = [
  'cohere.embed-multilingual-v3',
  'cohere.embed-v4:0',
  'amazon.titan-embed-text-v2:0',
] as const;

/** AWS region names (`us-east-1`, `eu-central-1`, `ap-southeast-2`, `us-gov-west-1`). */
export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
