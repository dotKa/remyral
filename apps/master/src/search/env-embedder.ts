import { readFile } from 'node:fs/promises';
import type { MasterConfig } from '../config.js';
import { BedrockEmbedder } from './bedrock.js';
import { type Embedder, HttpEmbedder, LocalHashEmbedder } from './embedder.js';

/**
 * The embedding provider configured by environment (SEARCH_PROVIDER …), null when none. Shared by the master process and
 * command-line tools that need the same provider (p17-auto-learning's backfill). Settings → Integrations → AWS Bedrock
 * still takes precedence when the caller runs `BedrockIntegration.refresh()`. The HTTP key is read from its file.
 */
export async function envEmbedder(search: MasterConfig['search']): Promise<Embedder | null> {
  if (search === null) return null;
  const p = search.provider;
  if (p.kind === 'local-hash') return new LocalHashEmbedder();
  if (p.kind === 'bedrock') {
    // p10-semantic-memory: credentials from the AWS SDK default chain (env or instance profile).
    return new BedrockEmbedder({
      region: p.region,
      modelId: p.model,
      ...(p.dimensions === null ? {} : { dimensions: p.dimensions }),
    });
  }
  return new HttpEmbedder({
    url: p.url,
    model: p.model,
    apiKey: (await readFile(p.keyFile, 'utf8')).trim(),
    ...(p.dimensions === null ? {} : { dimensions: p.dimensions }),
  });
}
