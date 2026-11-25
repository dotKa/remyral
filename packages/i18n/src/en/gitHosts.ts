import type { Shape } from '../shape.js';
import type tr from '../tr/gitHosts.js';

/**
 * p16-git-providers (ADR-0061): Settings → Integrations → GitLab and Bitbucket (access tokens kept by the master) and
 * the provider choice in Projects → Repository (GitHub / GitLab / Bitbucket / plain git).
 */
export default {
  kinds: { gitlab: 'GitLab', bitbucket: 'Bitbucket Cloud' },
  tokenKinds: {
    project: 'Project access token',
    group: 'Group access token',
    personal: 'Personal access token',
    repository: 'Repository access token',
    workspace: 'Workspace access token',
  },
  settings: {
    title: 'GitLab and Bitbucket',
    sub: 'The master opens merge requests / pull requests, reads CI and performs approved merges with these tokens. A token is entered once, stored encrypted, never shown again and never sent to a model.',
    loading: 'Loading connections',
    none: 'No GitLab or Bitbucket connection yet.',
    add: 'Connect GitLab / Bitbucket',
    addTitle: 'New connection',
    kind: 'Provider',
    label: 'Name',
    labelPlaceholder: 'e.g. Company GitLab',
    baseUrl: 'GitLab address',
    baseUrlHint: 'gitlab.com or your company’s GitLab server (https://…). Do not add /api/v4.',
    tokenKind: 'Token kind',
    scope: 'Token scope',
    scopeHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'group/project for a project token, the group path for a group token; may stay empty for a personal token.'
        : 'workspace/repository for a repository token, workspace/PROJECT for a project token, the workspace alone for a workspace token.',
    token: 'Access token',
    tokenHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'Scope: api. Role: Maintainer (to merge). The token is never shown again.'
        : 'Scopes: repository:write, pullrequest:write, pipeline (Bitbucket no longer accepts app passwords). The token is never shown again.',
    pushToken: 'Push token for machines (recommended)',
    pushTokenHint: (p: { kind: string }) =>
      p.kind === 'gitlab'
        ? 'A separate token with the write_repository scope only. Left empty, machines get the API token.'
        : 'A separate token with the repository:write scope only. Left empty, machines get the API token.',
    expiresAt: 'Expiry date',
    expiresAtHint:
      'Bitbucket does not report a token’s expiry; enter it if you know it and Keys and expiry will remind you. GitLab reports its own.',
    test: 'Test connection',
    save: 'Save connection',
    cancel: 'Cancel',
    retest: 'Test again',
    rotate: 'Rotate the token on GitLab',
    rotateQuestion:
      'GitLab issues a new token and revokes the old one at once. The master keeps working with the new one. Rotate?',
    replace: 'Enter a new token',
    replaceTitle: 'New token',
    replaceHint: 'The new token is tested before it is saved; if it fails, the old one stays.',
    removePush: 'Remove the separate push token',
    remove: 'Remove connection',
    removeQuestion: 'Delete this connection and its tokens? It cannot be removed while a project uses it.',
    stepUpSave: 'Save the GitLab / Bitbucket token — enter a current verification code.',
    stepUpRotate: 'Rotate the GitLab token — enter a current verification code.',
    stepUpReplace: 'Save the new token — enter a current verification code.',
    stepUpRemove: 'Remove the connection — enter a current verification code.',
    saved: 'Connection saved.',
    rotated: 'Token rotated; the old token no longer works.',
    replaced: 'New token saved.',
    removed: 'Connection removed.',
    usable: 'Usable',
    unusable: 'Token cannot be read — enter it again',
    expires: (p: { date: string }) => `Expires: ${p.date}`,
    noExpiry: 'Expiry unknown',
    fingerprint: (p: { fp: string }) => `Token fingerprint ${p.fp}`,
    pushSeparate: 'Machines get the separate push token',
    pushShared: 'Machines get the API token — a separate push-only token is recommended',
    projects: (p: { list: string }) => `Used by: ${p.list}`,
    unused: 'No project uses it yet',
    lastTestOk: (p: { at: string }) => `Last test passed (${p.at})`,
    lastTestFailed: (p: { reason: string }) => `Last test failed: ${p.reason}`,
    neverTested: 'Never tested',
    testOk: (p: { name: string }) => `The connection works${p.name === '' ? '' : ` — token “${p.name}”`}.`,
    testScopes: (p: { scopes: string }) => `Scopes: ${p.scopes}`,
    testExpires: (p: { date: string }) => `Token expires: ${p.date}`,
    testFailed: (p: { reason: string }) => `The connection does not work: ${p.reason}`,
    codes: {
      unauthorized: 'the token was refused (wrong, expired or revoked)',
      forbidden: 'the token is valid but cannot read its scope',
      not_found: 'the token or its scope was not found',
      scope_mismatch: 'the token cannot reach the given project, group, repository or workspace',
      missing_scopes: 'the token lacks a scope it needs',
      inactive: 'the token is revoked or inactive',
      unreachable: 'the server could not be reached',
      undecryptable: 'the stored token could not be decrypted (the master key changed) — enter it again',
      push: 'push token: ',
      other: (p: { code: string }) => `unexpected answer (${p.code})`,
    },
  },
  repo: {
    connection: 'Connection',
    connectionValue: (p: { label: string; host: string }) => `${p.label} · ${p.host}`,
    noConnections: (p: { kind: string }) =>
      `No ${p.kind} connection yet. Add one first in Settings → Integrations → GitLab and Bitbucket.`,
    connectionsUnavailable:
      'The connections could not be read (needs an administrator). The connection stays as it is.',
    pickConnection: 'Choose a connection',
    testConnection: 'Test connection',
    search: 'Search repositories',
    searchPlaceholder: 'group/project',
    reposLabel: 'Repositories of the connection',
    reposLoading: 'Loading repositories',
    noRepos: 'No matching repository. The token’s scope may not include it.',
    mergeHint:
      'On GitLab the merge follows the project’s setting (merge commit / fast-forward); squash is optional. Rebase merges are not offered.',
  },
} satisfies Shape<typeof tr>;
