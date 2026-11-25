import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { AWS_REGION_PATTERN, bedrockModelSpec, type BedrockModelSpec } from './bedrock-models.js';
import { type Embedder, EmbeddingError, type EmbedPurpose, l2normalize } from './embedder.js';

/**
 * p10-semantic-memory (docs/design/p10-semantic-memory.md §3): Amazon Bedrock embeddings — the documented default
 * provider (by design: Cohere Embed Multilingual on Bedrock; no model runs on the control plane).
 *
 * Calls `InvokeModel` (`POST /model/{modelId}/invoke` on `bedrock-runtime.<region>.amazonaws.com`) through the
 * official AWS SDK v3 client, which signs with SigV4 and takes its credentials from the SDK's default provider
 * chain: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) in the master's environment,
 * or an EC2 instance profile when one is attached (no static keys at all). The keys never pass through this module,
 * the config loader or a log line.
 *
 * Request/response shapes (verified against the Bedrock user guide, docs/design/p10-semantic-memory.md §3):
 *
 * | Family | Model ids | Request | Response |
 * | --- | --- | --- | --- |
 * | Cohere Embed v3 | `cohere.embed-multilingual-v3` | `{ texts ≤ 96 (≤ 2048 chars each), input_type, truncate: "END" }` | `{ embeddings: number[1024][] }` |
 * | Cohere Embed v4 | `cohere.embed-v4:0` (optionally with a `us.`/`eu.`/`apac.`/`global.` inference-profile prefix) | `{ texts ≤ 96, input_type, embedding_types: ["float"], output_dimension, truncate: "RIGHT" }` | `{ embeddings: number[][] }` or `{ embeddings: { float: number[][] } }` |
 * | Titan Text Embeddings V2 | `amazon.titan-embed-text-v2:0` | `{ inputText, dimensions, normalize: true }` (one text per call) | `{ embedding: number[] }` |
 *
 * `input_type` is `search_document` for indexed text and `search_query` for queries (Cohere's asymmetric search).
 */

/** Sends one InvokeModel request and returns the response body as text (injectable for tests). */
export type BedrockInvoke = (modelId: string, body: string, signal: AbortSignal) => Promise<string>;

export interface BedrockEmbedderOptions {
  readonly region: string;
  readonly modelId: string;
  /** Output dimensions (Cohere v4: 256/512/1024/1536; Titan V2: 256/512/1024). Omitted: the model's default. */
  readonly dimensions?: number;
  readonly timeoutMs?: number;
  /** Tests: a fake Bedrock endpoint (the SDK still signs every request with SigV4). */
  readonly endpoint?: string;
  /**
   * Static credentials instead of the SDK's default provider chain: Settings → Integrations → AWS Bedrock
   * (p10-bedrock-integration-panel; decrypted by the master per client, passed only to the SDK client — never into
   * process.env, a log line or a worker) and tests.
   */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** Tests: replaces the SDK call entirely. */
  readonly invoke?: BedrockInvoke;
}

const Vector = z.array(z.number()).min(1).max(8192);
const CohereResponse = z.object({
  embeddings: z.union([z.array(Vector), z.object({ float: z.array(Vector) })]),
});
const TitanResponse = z.object({ embedding: Vector });

/**
 * A failed Bedrock call: only the SDK's error name (e.g. `AccessDeniedException`) and HTTP status — never its
 * message (it can carry account ids / ARNs), the text or the credentials. p10-bedrock-integration-panel: "Test
 * connection" shows exactly these two fields.
 */
export class BedrockCallError extends EmbeddingError {
  constructor(
    readonly awsError: string,
    readonly httpStatus: number | null,
  ) {
    super(
      `Bedrock embedding call failed (${httpStatus === null ? awsError : `${awsError}, HTTP ${String(httpStatus)}`})`,
    );
  }
}

/** The SDK's error name and HTTP status — never its message. */
function sdkCallError(err: unknown): BedrockCallError {
  if (typeof err !== 'object' || err === null) return new BedrockCallError('error', null);
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  const safeName = typeof name === 'string' && /^[A-Za-z]{1,64}$/.test(name) ? name : 'error';
  return new BedrockCallError(
    safeName,
    typeof status === 'number' && Number.isInteger(status) ? status : null,
  );
}

function sdkInvoke(opts: BedrockEmbedderOptions): BedrockInvoke {
  const client = new BedrockRuntimeClient({
    region: opts.region,
    // Throttling / 5xx are retried by the SDK with backoff; the abort signal bounds the whole call.
    maxAttempts: 3,
    ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
    ...(opts.credentials === undefined ? {} : { credentials: { ...opts.credentials } }),
  });
  return async (modelId, body, signal) => {
    const out = await client.send(
      new InvokeModelCommand({ modelId, body, contentType: 'application/json', accept: 'application/json' }),
      { abortSignal: signal },
    );
    return new TextDecoder().decode(out.body);
  };
}

export class BedrockEmbedder implements Embedder {
  readonly model: string;
  readonly maxBatch: number;
  readonly maxChars: number;
  readonly provider = 'bedrock';
  readonly dims: number;
  readonly region: string;
  private readonly spec: BedrockModelSpec;
  private readonly invoke: BedrockInvoke;

  constructor(private readonly opts: BedrockEmbedderOptions) {
    const spec = bedrockModelSpec(opts.modelId);
    if (spec === null) throw new RangeError('unsupported Bedrock embedding model');
    if (!AWS_REGION_PATTERN.test(opts.region)) throw new RangeError('invalid AWS region');
    const dims = opts.dimensions ?? spec.dims[0] ?? 1024;
    if (!spec.dims.includes(dims)) throw new RangeError('unsupported dimensions for this Bedrock model');
    this.spec = spec;
    this.dims = dims;
    this.region = opts.region;
    this.maxBatch = spec.maxBatch;
    this.maxChars = spec.maxChars;
    // The vector space: model plus non-default dimensions (a change means a reindex).
    this.model = `bedrock:${opts.modelId}${dims === spec.dims[0] ? '' : `:${String(dims)}`}`;
    this.invoke = opts.invoke ?? sdkInvoke(opts);
  }

  async embed(texts: readonly string[], purpose: EmbedPurpose = 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (texts.length > this.maxBatch)
      throw new EmbeddingError(`batch of ${String(texts.length)} > ${String(this.maxBatch)}`);
    if (texts.some((t) => t.length === 0 || t.length > this.maxChars)) {
      throw new EmbeddingError('text empty or longer than the model accepts');
    }
    const vectors =
      this.spec.family === 'titan-v2'
        ? await Promise.all(texts.map((t) => this.titan(t)))
        : await this.cohere(texts, purpose);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dims)) {
      throw new EmbeddingError('Bedrock returned missing or inconsistent vectors');
    }
    return vectors.map((v) => l2normalize(Float32Array.from(v)));
  }

  private async call(body: Record<string, unknown>): Promise<unknown> {
    let text: string;
    try {
      text = await this.invoke(
        this.opts.modelId,
        JSON.stringify(body),
        AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      );
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw sdkCallError(err);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new EmbeddingError('Bedrock returned an unexpected response');
    }
  }

  private async cohere(texts: readonly string[], purpose: EmbedPurpose): Promise<number[][]> {
    const inputType = purpose === 'query' ? 'search_query' : 'search_document';
    const body: Record<string, unknown> =
      this.spec.family === 'cohere-v3'
        ? { texts, input_type: inputType, truncate: 'END' }
        : {
            texts,
            input_type: inputType,
            embedding_types: ['float'],
            output_dimension: this.dims,
            truncate: 'RIGHT',
          };
    const parsed = CohereResponse.safeParse(await this.call(body));
    if (!parsed.success) throw new EmbeddingError('Bedrock returned an unexpected response');
    const e = parsed.data.embeddings;
    return Array.isArray(e) ? e : e.float;
  }

  private async titan(text: string): Promise<number[]> {
    const parsed = TitanResponse.safeParse(
      await this.call({ inputText: text, dimensions: this.dims, normalize: true }),
    );
    if (!parsed.success) throw new EmbeddingError('Bedrock returned an unexpected response');
    return parsed.data.embedding;
  }
}
