import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §7): what every audit entry written while serving a request should
 * carry without each service passing it along — today the API token the request was authenticated with, so an entry
 * made by a token says which one (`metadata.viaApi`). Entered by a preValidation hook in app.ts (after body parsing,
 * so the handler and its preHandlers run inside it).
 */
export interface AuditRequestContext {
  /** The id (never the secret) of the API token the request was authenticated with. */
  readonly apiTokenId?: string;
  /**
   * p16-assistant-admin (docs/design/p16-assistant-admin.md §6): the change is made through the chat. Administration
   * from the assistant calls the console's services, so their entries keep the console's action names; this adds
   * `metadata.source` to every entry they write (an entry naming a source keeps it).
   */
  readonly source?: 'chat';
}

export const auditRequestContext = new AsyncLocalStorage<AuditRequestContext>();

/** Runs `fn` so that every audit entry recorded inside it (also in awaited calls) carries `source`. */
export function withAuditSource<T>(source: 'chat', fn: () => Promise<T>): Promise<T> {
  return auditRequestContext.run({ ...auditRequestContext.getStore(), source }, fn);
}
