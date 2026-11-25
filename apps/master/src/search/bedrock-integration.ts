import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import type { Pool } from '../db/pool.js';
import { OpsError } from '../ops/model.js';
import { BedrockCallError, BedrockEmbedder } from './bedrock.js';
import { AWS_REGION_PATTERN, BEDROCK_MODEL_IDS, DEFAULT_BEDROCK_MODEL } from './bedrock-models.js';
import { type Embedder, EmbeddingError } from './embedder.js';
import type { ProviderMeta, ProviderSource, SearchService } from './service.js';

/**
 * p10-bedrock-integration-panel (docs/design/p10-semantic-memory.md §11): Settings → Integrations → AWS Bedrock
 * (embeddings), and which embedding provider is active.
 *
 * **Storage** — exactly like the Coolify / Cloudflare tokens (ADR-0028, src/ops/integrations.ts): one row
 * `provider = 'bedrock'` in `ops_integrations`; the access key id + secret access key are one AES-256-GCM blob under
 * the HKDF sub-key `ops-integrations` of the master key file, AAD `ops-integration:bedrock`. They are never returned,
 * logged, audited (only a fingerprint), put into `process.env`, sent to a worker or shown to the chat assistant; the
 * master decrypts them only to build the Bedrock client (static credentials provider) or run "Test connection".
 *
 * **Precedence** (`resolveProvider`, pure):
 *
 * | SEARCH_PROVIDER (env) | panel row | active provider | source |
 * | --- | --- | --- | --- |
 * | `off` | any | none (kill switch) | — |
 * | `http` / `local-hash` | any | the env provider (the panel row is kept but inactive) | environment |
 * | unset / `none` / `bedrock` | usable | Bedrock with the panel's region, model and keys | panel |
 * | `bedrock` | none / undecryptable | Bedrock from env (SDK default chain) | environment / instance role |
 * | unset / `none` | none / undecryptable | none | — |
 */

/** Regions where Cohere Embed Multilingual v3 (the default model) runs in-Region (Bedrock user guide, 2026-10-18). */
export const BEDROCK_PANEL_REGIONS = [
  'us-east-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'ap-northeast-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
] as const;

/** The models the panel offers (no inference-profile prefixes: in-Region invocation only). */
export const BEDROCK_PANEL_MODELS = BEDROCK_MODEL_IDS;

export const BedrockPanelSettings = z.strictObject({
  region: z.string().regex(AWS_REGION_PATTERN, 'AWS region'),
  model: z.enum(BEDROCK_PANEL_MODELS),
});
export type BedrockPanelSettings = z.infer<typeof BedrockPanelSettings>;

/** Long-term IAM user access key (`AKIA…`, 20 characters). Temporary `ASIA…` keys need a session token: not offered. */
export const AccessKeyId = z.string().regex(/^AKIA[A-Z0-9]{16}$/, 'AWS access key id (AKIA…)');
export const SecretAccessKey = z
  .string()
  .regex(/^[A-Za-z0-9/+]{40}$/, 'AWS secret access key (40 characters)');

const StoredKeys = z.strictObject({ accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey });
type StoredKeys = z.infer<typeof StoredKeys>;

const StoredConfig = BedrockPanelSettings.extend({ keyIdHint: z.string().regex(/^[A-Z0-9]{4}$/) });
type StoredConfig = z.infer<typeof StoredConfig>;

/** SEARCH_PROVIDER as the operator configured it (`unset` = empty or `none`: the panel decides). */
export type SearchEnvMode = 'unset' | 'off' | 'bedrock' | 'http' | 'local-hash';

export interface SearchEnv {
  readonly mode: SearchEnvMode;
  /** The provider built from env (null for `unset` / `off`). */
  readonly embedder: Embedder | null;
  /** SEARCH_BEDROCK_REGION / AWS_REGION with `bedrock`, else null. */
  readonly region: string | null;
  /**
   * With `bedrock` from env: `environment` when AWS_ACCESS_KEY_ID is set in the master's environment (main.ts checks
   * presence only, never the value), else `instance role` (SDK default chain → EC2 instance profile).
   */
  readonly credentialSource: 'environment' | 'instance role';
}

export interface ProviderDecision {
  readonly kind: 'none' | 'env' | 'panel';
  readonly source: ProviderSource | null;
  /** Why the panel row is not in use, for Settings (null when it is, or when there is none). */
  readonly panelInactiveReason: string | null;
}

/** The precedence table above (pure; unit-tested). */
export function resolveProvider(
  env: Pick<SearchEnv, 'mode' | 'embedder' | 'credentialSource'>,
  panel: 'none' | 'usable' | 'unusable',
): ProviderDecision {
  if (env.mode === 'off') {
    return {
      kind: 'none',
      source: null,
      panelInactiveReason:
        panel === 'none' ? null : 'SEARCH_PROVIDER=off on the server switches semantic search off.',
    };
  }
  if (env.mode === 'http' || env.mode === 'local-hash') {
    return {
      kind: env.embedder === null ? 'none' : 'env',
      source: env.embedder === null ? null : 'environment',
      panelInactiveReason:
        panel === 'none'
          ? null
          : `SEARCH_PROVIDER=${env.mode} on the server takes precedence over the panel.`,
    };
  }
  if (panel === 'usable') return { kind: 'panel', source: 'panel', panelInactiveReason: null };
  const unusable =
    panel === 'unusable'
      ? 'The stored keys cannot be decrypted (master key changed?) — enter them again.'
      : null;
  if (env.mode === 'bedrock' && env.embedder !== null) {
    return { kind: 'env', source: env.credentialSource, panelInactiveReason: unusable };
  }
  return { kind: 'none', source: null, panelInactiveReason: unusable };
}

/** The minimal IAM policy for a region + model (shown in the panel; same text in the canvas note). */
export function bedrockIamPolicy(region: string, model: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'RemyralEmbeddingsOnly',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModel',
        Resource: `arn:aws:bedrock:${region}::foundation-model/${model}`,
      },
    ],
  };
}

/** A short, actionable hint per AWS error type (never the AWS message). */
export function bedrockErrorHint(awsError: string, httpStatus: number | null): string {
  switch (awsError) {
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
    case 'IncompleteSignatureException':
    case 'SignatureDoesNotMatch':
    case 'InvalidClientTokenId':
      return 'AWS does not accept the access key: check the access key id and secret access key (and that the key is active).';
    case 'AccessDeniedException':
      return 'The key is valid but may not invoke this model: attach the IAM policy below, and enable model access for this model in the Bedrock console (one time, as an administrator).';
    case 'ResourceNotFoundException':
    case 'ValidationException':
      return 'This model is not available in this region (or not enabled): pick another region or model.';
    case 'ThrottlingException':
    case 'ServiceQuotaExceededException':
      return 'Bedrock throttled the request: try again in a minute.';
    case 'TimeoutError':
    case 'AbortError':
      return 'Bedrock did not answer in time: check the network path from the master to AWS.';
    default:
      return httpStatus !== null && httpStatus >= 500
        ? 'Bedrock had a server error: try again later.'
        : 'The test failed; the error type above names the cause.';
  }
}

export interface BedrockIntegrationView {
  readonly settings: BedrockPanelSettings;
  /** Last four characters of the access key id (to recognise the key in IAM). */
  readonly keyIdHint: string;
  readonly keyFingerprint: string;
  readonly usable: boolean;
  readonly lastTest: Record<string, unknown> | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
}

export interface BedrockStatus {
  readonly integration: BedrockIntegrationView | null;
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

export interface BedrockActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface BedrockIntegrationDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly box: SecretBox;
  readonly clock: () => Date;
  readonly search: SearchService;
  readonly env: SearchEnv;
  /** Tests: a fake Bedrock endpoint (the SDK still signs with SigV4). */
  readonly endpoint?: string;
  /** Per-call timeout of indexer / search calls (default 30 s) and of the connection test (default 15 s). */
  readonly timeoutMs?: number;
  readonly testTimeoutMs?: number;
  /**
   * p17-panel-settings Part 2: the panel's provider choice (Ayarlar → Sunucu ayarları → Arama), read on every refresh.
   * `http`: the HTTP embedding provider with the effective SEARCH_HTTP_* values (panel → environment) — `key` identifies
   * the configuration, `build` makes the embedder (null: incomplete); `bedrock`: the panel / env Bedrock as before even
   * when SEARCH_PROVIDER=http. null / absent: the environment decides (SEARCH_PROVIDER=off stays the kill switch).
   */
  readonly panelChoice?: () =>
    | {
        readonly kind: 'http';
        readonly key: string;
        readonly source: ProviderSource;
        readonly build: () => Embedder | null;
      }
    | { readonly kind: 'bedrock' }
    | null;
}

interface Row {
  config: Record<string, unknown>;
  secret: Buffer;
  key_fingerprint: string;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  updated_at: Date;
}

const AAD = 'ops-integration:bedrock';
/** The sample "Test connection" embeds: Turkish + English, no customer data. */
export const BEDROCK_TEST_TEXTS = [
  'Proje hafızası: derleme için pnpm kullanılır, testlerden önce lint çalıştırılır.',
  'Project memory: the build uses pnpm; lint runs before the tests.',
] as const;

const fingerprint = (k: StoredKeys): string =>
  createHash('sha256').update(`${k.accessKeyId}:${k.secretAccessKey}`, 'utf8').digest('hex').slice(0, 16);

export class BedrockIntegration {
  readonly #box: SecretBox;
  /** The applied decision + the row version it was built from (null = not yet applied). */
  #applied: { key: string; decision: ProviderDecision } | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BedrockIntegrationDeps) {
    // Same sub-key as the Coolify / Cloudflare tokens; the AAD binds the blob to the bedrock row.
    this.#box = new SecretBox(deps.box.deriveKey('ops-integrations'));
  }

  async #row(): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT config, secret, key_fingerprint, last_test, last_test_at, updated_at
         FROM ops_integrations WHERE provider = 'bedrock'`,
    );
    return rows[0] ?? null;
  }

  #keys(row: Row): StoredKeys | null {
    try {
      const parsed = StoredKeys.safeParse(JSON.parse(this.#box.decrypt(row.secret, AAD).toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (err instanceof SecretBoxError || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  #config(row: Row): StoredConfig | null {
    const parsed = StoredConfig.safeParse(row.config);
    return parsed.success ? parsed.data : null;
  }

  #embedder(config: BedrockPanelSettings, keys: StoredKeys, timeoutMs?: number): BedrockEmbedder {
    return new BedrockEmbedder({
      region: config.region,
      modelId: config.model,
      // Static credentials provider: the SDK uses exactly these keys, never the default chain.
      credentials: { accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey },
      ...(this.deps.endpoint === undefined ? {} : { endpoint: this.deps.endpoint }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /**
   * Re-reads the panel row and applies the resulting provider to the search service (startup, every indexer pass,
   * and after a panel change — then with the person as the actor of a provider-change audit). Serialised.
   */
  refresh(actor?: BedrockActor): Promise<void> {
    const run = this.#chain.then(() => this.#refresh(actor));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #refresh(actor?: BedrockActor): Promise<void> {
    const row = await this.#row();
    const config = row === null ? null : this.#config(row);
    const keys = row === null ? null : this.#keys(row);
    const panel = row === null ? 'none' : config !== null && keys !== null ? 'usable' : 'unusable';
    // p17-panel-settings Part 2: the panel's provider choice (never past the SEARCH_PROVIDER=off kill switch).
    const choice = this.deps.env.mode === 'off' ? null : (this.deps.panelChoice?.() ?? null);
    if (choice?.kind === 'http') {
      const key = `http|${choice.key}`;
      if (this.#applied?.key === key) return;
      const embedder = choice.build();
      this.deps.search.setProvider(embedder, {
        source: embedder === null ? null : choice.source,
        region: null,
      });
      this.#applied = {
        key,
        decision: {
          kind: embedder === null ? 'none' : choice.source === 'panel' ? 'panel' : 'env',
          source: embedder === null ? null : choice.source,
          panelInactiveReason:
            panel === 'none'
              ? null
              : 'The HTTP embedding provider is selected in Ayarlar → Sunucu ayarları → Arama.',
        },
      };
      if (actor !== undefined) await this.deps.search.noteProvider(actor);
      return;
    }
    // `bedrock` chosen in the panel: an env HTTP / local-hash provider does not take precedence any more.
    const env =
      choice?.kind === 'bedrock' && (this.deps.env.mode === 'http' || this.deps.env.mode === 'local-hash')
        ? { ...this.deps.env, mode: 'unset' as const, embedder: null }
        : this.deps.env;
    const decision = resolveProvider(env, panel);
    const key = `${decision.kind}|${row?.key_fingerprint ?? ''}|${row?.updated_at.toISOString() ?? ''}|${env.mode}`;
    if (this.#applied?.key === key) return;
    let embedder: Embedder | null = null;
    let meta: ProviderMeta = { source: null, region: null };
    if (decision.kind === 'panel' && config !== null && keys !== null) {
      embedder = this.#embedder(config, keys, this.deps.timeoutMs);
      meta = { source: 'panel', region: config.region };
    } else if (decision.kind === 'env') {
      embedder = env.embedder;
      meta = { source: decision.source, region: env.region };
    }
    this.deps.search.setProvider(embedder, meta);
    this.#applied = { key, decision };
    // A panel change records a model / region change right away (audited with the person; stale vectors dropped,
    // the next indexer pass rebuilds). Without a person the indexer pass records it as the system.
    if (actor !== undefined) await this.deps.search.noteProvider(actor);
  }

  async status(): Promise<BedrockStatus> {
    await this.refresh();
    const row = await this.#row();
    const info = await this.deps.search.providerInfo();
    const decision = this.#applied?.decision ?? resolveProvider(this.deps.env, 'none');
    return {
      integration: this.#view(row),
      active: {
        provider: info.provider,
        model: info.model,
        region: info.region,
        source: info.source,
        panelInUse: decision.kind === 'panel',
        panelInactiveReason: decision.panelInactiveReason,
      },
      env: { searchProvider: this.deps.env.mode, region: this.deps.env.region },
      options: {
        regions: [...BEDROCK_PANEL_REGIONS],
        models: [...BEDROCK_PANEL_MODELS],
        defaultModel: DEFAULT_BEDROCK_MODEL,
      },
    };
  }

  #view(row: Row | null): BedrockIntegrationView | null {
    if (row === null) return null;
    const config = this.#config(row);
    return {
      settings: {
        region: config?.region ?? '',
        model: config?.model ?? DEFAULT_BEDROCK_MODEL,
      },
      keyIdHint: config?.keyIdHint ?? '',
      keyFingerprint: row.key_fingerprint,
      usable: config !== null && this.#keys(row) !== null,
      lastTest: row.last_test,
      lastTestAt: row.last_test_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /**
   * Connect or change: region + model, and (first time: required) a new access key id + secret access key. Keys
   * omitted keep the stored ones. A change of keys or settings clears the last test.
   */
  async save(
    actor: BedrockActor,
    input: {
      readonly region: unknown;
      readonly model: unknown;
      readonly accessKeyId?: string | undefined;
      readonly secretAccessKey?: string | undefined;
    },
  ): Promise<BedrockIntegrationView> {
    const settings = BedrockPanelSettings.safeParse({ region: input.region, model: input.model });
    if (!settings.success)
      throw new OpsError(400, 'invalid_settings', 'Choose a valid AWS region and model.');
    const hasId = input.accessKeyId !== undefined && input.accessKeyId !== '';
    const hasSecret = input.secretAccessKey !== undefined && input.secretAccessKey !== '';
    if (hasId !== hasSecret) {
      throw new OpsError(400, 'keys_incomplete', 'Enter both the access key id and the secret access key.');
    }
    let keys: StoredKeys | null = null;
    if (hasId) {
      const id = AccessKeyId.safeParse(input.accessKeyId.trim());
      const secret = SecretAccessKey.safeParse(input.secretAccessKey?.trim());
      if (!id.success)
        throw new OpsError(400, 'invalid_access_key_id', 'Invalid access key id (AKIA… 20 characters).');
      if (!secret.success)
        throw new OpsError(400, 'invalid_secret_access_key', 'Invalid secret access key (40 characters).');
      keys = { accessKeyId: id.data, secretAccessKey: secret.data };
    }
    const existing = await this.#row();
    const existingConfig = existing === null ? null : this.#config(existing);
    if (keys === null && (existing === null || existingConfig === null)) {
      throw new OpsError(400, 'keys_required', 'Enter the access key id and the secret access key.');
    }
    const config: StoredConfig = {
      ...settings.data,
      keyIdHint: keys === null ? (existingConfig?.keyIdHint ?? '') : keys.accessKeyId.slice(-4),
    };
    const fp = keys === null ? (existing?.key_fingerprint ?? '') : fingerprint(keys);
    const secret = keys === null ? null : this.#box.encrypt(Buffer.from(JSON.stringify(keys), 'utf8'), AAD);
    const now = this.deps.clock();
    await this.deps.pool.query(
      `INSERT INTO ops_integrations (provider, config, secret, key_fingerprint, updated_by, created_at, updated_at)
       VALUES ('bedrock', $1, $2, $3, $4, $5, $5)
       ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config,
         secret = COALESCE($6, ops_integrations.secret),
         key_fingerprint = EXCLUDED.key_fingerprint,
         last_test = CASE WHEN $6 IS NULL AND ops_integrations.config = EXCLUDED.config
                          THEN ops_integrations.last_test ELSE NULL END,
         last_test_at = CASE WHEN $6 IS NULL AND ops_integrations.config = EXCLUDED.config
                             THEN ops_integrations.last_test_at ELSE NULL END,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [config, secret ?? existing?.secret, fp, actor.userId, now, secret],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'ops.integration.bedrock.save',
      target: 'ops-integration:bedrock',
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        keyFingerprint: fp,
        keyChanged: keys !== null,
        previousKeyFingerprint: existing?.key_fingerprint ?? null,
        settings: settings.data,
        previousSettings:
          existingConfig === null ? null : { region: existingConfig.region, model: existingConfig.model },
      },
    });
    await this.refresh(actor);
    const view = this.#view(await this.#row());
    if (view === null) throw new Error('integration row vanished');
    return view;
  }

  async remove(actor: BedrockActor): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      `DELETE FROM ops_integrations WHERE provider = 'bedrock'`,
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'ops.integration.bedrock.remove',
      target: 'ops-integration:bedrock',
      outcome: (rowCount ?? 0) > 0 ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });
    if ((rowCount ?? 0) === 0) throw new OpsError(404, 'not_configured', 'Not configured.');
    // Falls back to the environment (or no provider); a model / region change is audited with the person.
    await this.refresh(actor);
  }

  /**
   * "Test connection": embeds a short Turkish + English sample with the stored keys, region and model. The result
   * (no secrets: dimensions, latency, or the AWS error type + HTTP status) is stored and audited.
   */
  async test(actor: BedrockActor): Promise<Record<string, unknown>> {
    const row = await this.#row();
    if (row === null) throw new OpsError(404, 'not_configured', 'Not configured.');
    const config = this.#config(row);
    const keys = this.#keys(row);
    let result: Record<string, unknown>;
    if (config === null || keys === null) {
      result = {
        ok: false,
        error: 'KeysUnusable',
        httpStatus: null,
        hint: 'The stored keys cannot be decrypted (master key changed?) — enter them again.',
      };
    } else {
      const embedder = this.#embedder(config, keys, this.deps.testTimeoutMs ?? 15_000);
      const started = performance.now();
      try {
        const vectors = await embedder.embed([...BEDROCK_TEST_TEXTS], 'document');
        result = {
          ok: true,
          region: config.region,
          model: config.model,
          dims: vectors[0]?.length ?? 0,
          vectors: vectors.length,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (err) {
        if (!(err instanceof EmbeddingError)) throw err;
        const awsError = err instanceof BedrockCallError ? err.awsError : 'UnexpectedResponse';
        const httpStatus = err instanceof BedrockCallError ? err.httpStatus : null;
        result = {
          ok: false,
          region: config.region,
          model: config.model,
          error: awsError,
          httpStatus,
          latencyMs: Math.round(performance.now() - started),
          hint:
            err instanceof BedrockCallError
              ? bedrockErrorHint(awsError, httpStatus)
              : 'Bedrock answered with an unexpected response shape for this model.',
        };
      }
    }
    await this.deps.pool.query(
      `UPDATE ops_integrations SET last_test = $1, last_test_at = $2 WHERE provider = 'bedrock'`,
      [result, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'ops.integration.bedrock.test',
      target: 'ops-integration:bedrock',
      outcome: result.ok === true ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        ok: result.ok === true,
        error: result.error ?? null,
        httpStatus: result.httpStatus ?? null,
        dims: result.dims ?? null,
      },
    });
    return result;
  }
}
