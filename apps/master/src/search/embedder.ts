import { z } from 'zod';

/**
 * Embedding providers for the optional semantic search (p6-vector, docs/design/p6-vector.md §3).
 *
 * An `Embedder` turns texts into unit-length vectors. `model` identifies the vector space (vectors of
 * different models are never compared): a model change means a reindex. Two implementations:
 *
 * - `LocalHashEmbedder` — deterministic, in-process, no network: hashed unigrams + bigrams (the "hashing
 *   trick"). Lexical rather than semantic, but stable across processes and good enough for tests and for
 *   operators who want search without sending text anywhere.
 * - `HttpEmbedder` — an OpenAI-compatible `POST <url>` (`/v1/embeddings`: `{ model, input: string[] }` →
 *   `{ data: [{ index, embedding: number[] }] }`). The same shape is served by OpenAI, Voyage AI (the
 *   embeddings provider Anthropic recommends — Anthropic has no embeddings endpoint of its own) and local
 *   servers such as Ollama/LiteLLM. The API key comes from a secret file and is only sent as a bearer header.
 */
export interface Embedder {
  /** Vector-space identifier stored with every vector (e.g. `local-hash/v1:512`, `bedrock:cohere.embed-multilingual-v3`). */
  readonly model: string;
  /** Upper bound of texts per `embed` call. */
  readonly maxBatch: number;
  /**
   * p10-semantic-memory: upper bound of characters per text the provider accepts (Cohere v3 on Bedrock: 2048).
   * Undefined: the service's default clip (8000).
   */
  readonly maxChars?: number;
  /** p10-semantic-memory: provider label shown in Settings (`bedrock`, `http`, `local-hash`). */
  readonly provider?: string;
  /** p10-semantic-memory: vector length when known up front (shown in Settings), else learned from the vectors. */
  readonly dims?: number | undefined;
  /**
   * Unit-length vectors, one per text, in input order. `purpose` (p10-semantic-memory): `document` for what is
   * indexed, `query` for search queries — models with asymmetric embeddings (Cohere `input_type`) need it;
   * others ignore it. Omitted: `document`.
   */
  embed(texts: readonly string[], purpose?: EmbedPurpose): Promise<Float32Array[]>;
}

/** What a text is embedded as: an indexed document or a search query (p10-semantic-memory). */
export type EmbedPurpose = 'document' | 'query';

/** Thrown for provider failures; the message never contains the key or the submitted text. */
export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) * inv;
  return v;
}

/** Cosine similarity; both vectors are unit length, so the dot product. Different lengths → -1. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** FNV-1a, 32 bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export class LocalHashEmbedder implements Embedder {
  readonly model: string;
  readonly maxBatch = 256;
  readonly provider = 'local-hash';
  readonly dims: number;

  constructor(dims = 512) {
    if (!Number.isInteger(dims) || dims < 16 || dims > 4096) throw new RangeError('dims must be 16..4096');
    this.model = `local-hash/v1:${String(dims)}`;
    this.dims = dims;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.one(t)));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const toks = tokens(text);
    const add = (feature: string, weight: number): void => {
      const h = fnv1a(feature);
      const idx = h % this.dims;
      v[idx] = (v[idx] ?? 0) + (h & 0x80000000 ? -weight : weight);
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] ?? '';
      add(`u:${t}`, 1);
      if (i + 1 < toks.length) add(`b:${t} ${toks[i + 1] ?? ''}`, 0.5);
    }
    // Sub-linear term frequency: log-scale every bucket so one repeated word cannot dominate.
    for (let i = 0; i < v.length; i++) {
      const x = v[i] ?? 0;
      v[i] = Math.sign(x) * Math.log1p(Math.abs(x));
    }
    return l2normalize(v);
  }
}

export interface HttpEmbedderOptions {
  /** Full endpoint URL, e.g. https://api.openai.com/v1/embeddings (https, or http on loopback only). */
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
  /** Optional `dimensions` request field (OpenAI text-embedding-3 models). */
  readonly dimensions?: number;
  readonly timeoutMs?: number;
  readonly maxBatch?: number;
  readonly fetch?: typeof fetch;
}

const EmbeddingResponse = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number()).min(1).max(8192),
      }),
    )
    .min(1),
});

export class HttpEmbedder implements Embedder {
  readonly model: string;
  readonly maxBatch: number;
  readonly provider = 'http';
  readonly dims: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpEmbedderOptions) {
    if (!/^[A-Za-z0-9._:/@-]{1,160}$/.test(opts.model)) throw new RangeError('invalid embedding model id');
    this.model = `http:${opts.model}${opts.dimensions === undefined ? '' : `:${String(opts.dimensions)}`}`;
    this.maxBatch = opts.maxBatch ?? 32;
    this.dims = opts.dimensions;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (texts.length > this.maxBatch)
      throw new EmbeddingError(`batch of ${String(texts.length)} > ${String(this.maxBatch)}`);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.opts.model,
          input: texts,
          ...(this.opts.dimensions === undefined ? {} : { dimensions: this.opts.dimensions }),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new EmbeddingError(
        `embedding provider unreachable (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new EmbeddingError(`embedding provider answered HTTP ${String(res.status)}`);
    }
    let parsed: z.infer<typeof EmbeddingResponse>;
    try {
      parsed = EmbeddingResponse.parse(await res.json());
    } catch {
      throw new EmbeddingError('embedding provider returned an unexpected response');
    }
    const out = new Array<Float32Array | undefined>(texts.length);
    for (const d of parsed.data) {
      if (d.index >= texts.length) throw new EmbeddingError('embedding provider returned an unknown index');
      out[d.index] = l2normalize(Float32Array.from(d.embedding));
    }
    const dims = out[0]?.length;
    if (out.some((v) => v === undefined || v.length !== dims)) {
      throw new EmbeddingError('embedding provider returned missing or inconsistent vectors');
    }
    return out as Float32Array[];
  }
}
