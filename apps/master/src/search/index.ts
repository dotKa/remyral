export {
  BEDROCK_MODEL_IDS,
  type BedrockModelSpec,
  bedrockModelSpec,
  DEFAULT_BEDROCK_MODEL,
} from './bedrock-models.js';
export {
  BedrockCallError,
  type BedrockInvoke,
  BedrockEmbedder,
  type BedrockEmbedderOptions,
} from './bedrock.js';
export {
  cosine,
  EmbeddingError,
  type Embedder,
  type EmbedPurpose,
  HttpEmbedder,
  type HttpEmbedderOptions,
  l2normalize,
  LocalHashEmbedder,
} from './embedder.js';
export { searchRoutes } from './routes.js';
export {
  type SearchConsent,
  type SearchHit,
  SearchService,
  type SearchServiceDeps,
  type ProviderMeta,
  type ProviderSource,
  type SearchSettings,
  type SyncStats,
} from './service.js';
export {
  AccessKeyId,
  BEDROCK_PANEL_MODELS,
  BEDROCK_PANEL_REGIONS,
  BEDROCK_TEST_TEXTS,
  bedrockErrorHint,
  bedrockIamPolicy,
  BedrockIntegration,
  type BedrockIntegrationDeps,
  type BedrockStatus,
  type ProviderDecision,
  resolveProvider,
  SecretAccessKey,
  type SearchEnv,
  type SearchEnvMode,
} from './bedrock-integration.js';
export { bedrockRoutes } from './bedrock-routes.js';
export {
  type AppliedKnowledge,
  type BackfillStats,
  type MemoryMode,
  PLATFORM_DEFAULT,
  type ProjectKnowledgeChoice,
  type SemanticDefaults,
  SemanticDefaultsService,
} from './defaults.js';
export { semanticDefaultsRoutes } from './defaults-routes.js';
export {
  ChatKnowledge,
  type ChatKnowledgeDeps,
  type ChatKnowledgePrefs,
  type ChatPassStats,
  computeLinks,
  type OwnChatHit,
  type OwnChatResult,
  type RelatedItem,
  type RelatedResult,
  type ThreadKnowledge,
} from './chat-knowledge.js';
export { chatChunks, redactChatText } from './chat-text.js';
