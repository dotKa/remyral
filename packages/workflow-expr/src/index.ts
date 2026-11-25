export {
  checkSource,
  CUSTOM_FUNCTIONS,
  EXPR_LIMITS,
  type ExprContext,
  ExprError,
  expressionsIn,
  type FieldMode,
  isTemplate,
  type NodeComputation,
  REFUSED_FUNCTIONS,
  regexAllowed,
  schemaIssues,
  type SandboxRequest,
  type SandboxResult,
  templateParts,
} from './sandbox-worker.js';
export { DEFAULT_RESOURCE_LIMITS, SandboxPool, type SandboxPoolOptions } from './pool.js';
export { JSONATA_FUNCTIONS } from './functions.js';
