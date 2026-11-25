import { apiRequest, int, nullableStr, obj, str, strArray } from './client';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md, ADR-0058): personal API tokens (`/me/api-tokens`), every token for
 * administrators (`/api-tokens`), service accounts (`/service-accounts`). A secret arrives only in the answer of
 * create / rotate and is never stored by the console.
 */

export const TOKEN_SCOPES = ['read', 'jobs:write', 'approvals', 'deploy', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type TokenState = 'active' | 'expired' | 'revoked';
export type ServiceRole = 'admin' | 'operator' | 'viewer';
export const SERVICE_ROLES: readonly ServiceRole[] = ['admin', 'operator', 'viewer'];

export interface UserRef {
  readonly id: string;
  readonly username: string;
}

export interface ApiToken {
  readonly id: string;
  readonly kind: 'personal' | 'service';
  readonly principal: UserRef & { readonly role: string };
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly grantedEvents: readonly string[];
  readonly allowedCidrs: readonly string[];
  readonly hint: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
  readonly rotatedAt: string | null;
  readonly previousValidUntil: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string | null;
  readonly useCount: number;
  readonly state: TokenState;
}

export interface TokenRules {
  readonly personal: boolean;
  readonly maxDays: number;
  readonly defaultDays: number;
  readonly eventGrants: boolean;
  readonly scopes: readonly TokenScope[];
  readonly grantableEvents: readonly string[];
  readonly maxCidrs: number;
  readonly maxOverlapMinutes: number;
}

export interface IssuedToken {
  readonly token: ApiToken;
  /** Shown once; never stored by the console. */
  readonly secret: string;
}

export interface ServiceAccount {
  readonly id: string;
  readonly name: string;
  readonly role: ServiceRole;
  readonly description: string | null;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
  readonly memberships: readonly { readonly project: string; readonly role: string }[];
  readonly tokens: readonly ApiToken[];
}

export interface CreateTokenInput {
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly expiresInDays: number;
  readonly allowedCidrs?: readonly string[];
  readonly grantedEvents?: readonly string[];
}

export interface RotateTokenInput {
  readonly overlapMinutes?: number;
  readonly expiresInDays?: number;
}

function ref(v: unknown): UserRef | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { id: str(o, 'id'), username: str(o, 'username') };
}

function scopes(o: Record<string, unknown>, key: string): TokenScope[] {
  return strArray(o, key).filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));
}

export function parseToken(v: unknown): ApiToken {
  const o = obj(v);
  const p = obj(o.principal);
  const state = o.state === 'expired' || o.state === 'revoked' ? o.state : 'active';
  return {
    id: str(o, 'id'),
    kind: o.kind === 'service' ? 'service' : 'personal',
    principal: { id: str(p, 'id'), username: str(p, 'username'), role: str(p, 'role') },
    name: str(o, 'name'),
    scopes: scopes(o, 'scopes'),
    grantedEvents: strArray(o, 'grantedEvents'),
    allowedCidrs: strArray(o, 'allowedCidrs'),
    hint: str(o, 'hint'),
    expiresAt: str(o, 'expiresAt'),
    createdAt: str(o, 'createdAt'),
    createdBy: ref(o.createdBy),
    rotatedAt: nullableStr(o, 'rotatedAt'),
    previousValidUntil: nullableStr(o, 'previousValidUntil'),
    revokedAt: nullableStr(o, 'revokedAt'),
    lastUsedAt: nullableStr(o, 'lastUsedAt'),
    lastUsedIp: nullableStr(o, 'lastUsedIp'),
    useCount: int(o, 'useCount'),
    state,
  };
}

export function parseRules(v: unknown): TokenRules {
  const o = obj(v);
  return {
    personal: o.personal === true,
    maxDays: int(o, 'maxDays'),
    defaultDays: int(o, 'defaultDays'),
    eventGrants: o.eventGrants === true,
    scopes: scopes(o, 'scopes'),
    grantableEvents: strArray(o, 'grantableEvents'),
    maxCidrs: int(o, 'maxCidrs'),
    maxOverlapMinutes: int(o, 'maxOverlapMinutes'),
  };
}

function parseIssued(v: unknown): IssuedToken {
  const o = obj(v);
  return { token: parseToken(o.token), secret: str(o, 'secret') };
}

function list(v: unknown): ApiToken[] {
  const items = obj(v).items;
  return Array.isArray(items) ? items.map(parseToken) : [];
}

export function parseServiceAccount(v: unknown): ServiceAccount {
  const o = obj(v);
  const role = o.role === 'admin' || o.role === 'operator' ? o.role : 'viewer';
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    role,
    description: nullableStr(o, 'description'),
    disabled: o.disabled === true,
    createdAt: str(o, 'createdAt'),
    createdBy: ref(o.createdBy),
    memberships: Array.isArray(o.memberships)
      ? o.memberships.map((m) => {
          const x = obj(m);
          return { project: str(x, 'project'), role: str(x, 'role') };
        })
      : [],
    tokens: Array.isArray(o.tokens) ? o.tokens.map(parseToken) : [],
  };
}

// ------------------------------------------------------------------ personal

export function listMyTokens(): Promise<{ items: ApiToken[]; rules: TokenRules }> {
  return apiRequest('GET', '/me/api-tokens', (b) => ({ items: list(b), rules: parseRules(obj(b).rules) }));
}

export function createMyToken(input: CreateTokenInput): Promise<IssuedToken> {
  return apiRequest('POST', '/me/api-tokens', parseIssued, { body: input });
}

export function rotateMyToken(id: string, input: RotateTokenInput): Promise<IssuedToken> {
  return apiRequest('POST', `/me/api-tokens/${encodeURIComponent(id)}/rotate`, parseIssued, { body: input });
}

export function revokeMyToken(id: string): Promise<ApiToken> {
  return apiRequest('DELETE', `/me/api-tokens/${encodeURIComponent(id)}`, (b) => parseToken(obj(b).token));
}

// ------------------------------------------------------------------ administrators

export function listAllTokens(kind?: 'personal' | 'service'): Promise<ApiToken[]> {
  return apiRequest('GET', kind === undefined ? '/api-tokens' : `/api-tokens?kind=${kind}`, list);
}

export function revokeAnyToken(id: string): Promise<ApiToken> {
  return apiRequest('DELETE', `/api-tokens/${encodeURIComponent(id)}`, (b) => parseToken(obj(b).token));
}

export function listServiceAccounts(): Promise<{ items: ServiceAccount[]; rules: TokenRules }> {
  return apiRequest('GET', '/service-accounts', (b) => {
    const o = obj(b);
    return {
      items: Array.isArray(o.items) ? o.items.map(parseServiceAccount) : [],
      rules: parseRules(o.rules),
    };
  });
}

export function createServiceAccount(input: {
  readonly name: string;
  readonly role: ServiceRole;
  readonly description?: string | null;
}): Promise<ServiceAccount> {
  return apiRequest('POST', '/service-accounts', parseServiceAccount, { body: input });
}

export function updateServiceAccount(
  id: string,
  patch: { readonly role?: ServiceRole; readonly description?: string | null; readonly disabled?: boolean },
): Promise<ServiceAccount> {
  return apiRequest('PATCH', `/service-accounts/${encodeURIComponent(id)}`, parseServiceAccount, {
    body: patch,
  });
}

export function createServiceToken(accountId: string, input: CreateTokenInput): Promise<IssuedToken> {
  return apiRequest('POST', `/service-accounts/${encodeURIComponent(accountId)}/tokens`, parseIssued, {
    body: input,
  });
}

export function rotateServiceToken(
  accountId: string,
  tokenId: string,
  input: RotateTokenInput,
): Promise<IssuedToken> {
  return apiRequest(
    'POST',
    `/service-accounts/${encodeURIComponent(accountId)}/tokens/${encodeURIComponent(tokenId)}/rotate`,
    parseIssued,
    { body: input },
  );
}

/** Days until `iso` from `now` (ceil; ≤ 0 when past). */
export function daysLeft(iso: string, now: number = Date.now()): number {
  return Math.ceil((Date.parse(iso) - now) / (24 * 60 * 60_000));
}

/** The curl line the console shows next to a new secret (the console origin + /api). */
export function curlExample(origin: string, secret: string): string {
  return `curl -H "Authorization: Bearer ${secret}" ${origin}/api/jobs?limit=5`;
}
