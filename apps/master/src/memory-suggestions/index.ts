export {
  bestLexical,
  bestSemantic,
  classify,
  jaccard,
  LEXICAL_THRESHOLDS,
  SEMANTIC_THRESHOLDS,
  semanticThresholds,
  type Thresholds,
  type Verdict,
} from './dedupe.js';
export {
  extractChatLearnings,
  extractLearnings,
  fingerprint,
  isDecision,
  type Learning,
  normalizeLearning,
} from './extract.js';
export { memorySuggestionRoutes } from './routes.js';
export {
  AGENT_SUMMARY_MARKER,
  MemorySuggestionService,
  type PassStats,
  type ProposeResult,
  type SuggestionMode,
  type SuggestionSettings,
  type SuggestionView,
} from './service.js';
