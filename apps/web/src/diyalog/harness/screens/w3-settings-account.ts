import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Ayarlar → Profil (Coolify, personal rules), Cihazlar (push devices,
 * trusted browsers), Sohbet (my conversations, the assistant with engines on two machines) and Bildirimler
 * (targets + per-kind matrix). Also used by apps/web/test/diyalog-w3-settings-account.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const later = (ms: number): string => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const ACC_TRUSTED = {
  devices: [
    {
      id: '00000000-0000-4000-8000-0000000d0001',
      label: 'Chrome · macOS',
      createdAt: iso(10 * DAY),
      lastUsedAt: iso(2 * HOUR),
      expiresAt: later(20 * DAY),
      createdIp: '198.51.100.7',
      current: true,
    },
    {
      id: '00000000-0000-4000-8000-0000000d0002',
      label: 'Safari · iPhone',
      createdAt: iso(25 * DAY),
      lastUsedAt: iso(3 * DAY),
      expiresAt: later(5 * DAY),
      createdIp: null,
      current: false,
    },
  ],
};

export const ACC_PUSH = {
  available: true,
  publicKey: 'BEl6dGVzdC1rZXk',
  devices: [
    {
      id: '00000000-0000-4000-8000-0000000e0001',
      label: 'Remyral · Android',
      service: 'fcm.googleapis.com',
      createdAt: iso(12 * DAY),
      lastSeenAt: iso(40 * 60_000),
      lastSuccessAt: iso(3 * HOUR),
    },
    {
      id: '00000000-0000-4000-8000-0000000e0002',
      label: 'Firefox · Linux',
      service: 'updates.push.services.mozilla.com',
      createdAt: iso(4 * DAY),
      lastSeenAt: iso(2 * DAY),
      lastSuccessAt: null,
    },
  ],
};

export const ACC_PREFS = {
  kinds: [
    {
      kind: 'approval.requested',
      label: 'Approval requested',
      description: 'A job asks for a decision you are allowed to make.',
      email: true,
      webhook: false,
      push: true,
    },
    {
      kind: 'job.failed',
      label: 'Job failed or lost',
      description: 'A job failed, timed out or its machine was lost.',
      email: true,
      webhook: true,
      push: true,
    },
    {
      kind: 'deploy.waiting',
      label: 'Deploy waiting',
      description: 'A deploy waits for approval.',
      email: false,
      webhook: false,
      push: false,
    },
  ],
  channels: {
    email: { available: true, address: 'alex@example.com' },
    webhook: { available: true, url: 'https://hooks.example.com/remyral' },
    push: { available: true, devices: 2 },
  },
};

export const ACC_KNOWLEDGE_PREFS = {
  indexConversations: true,
  shareProjects: false,
  autoRelated: true,
  version: 3,
};

export const ACC_CHAT_SETTINGS = {
  enabled: true,
  workerId: 'w1',
  runtime: 'claude-code',
  engines: [
    {
      workerId: 'w1',
      workerName: 'atlas-win-01',
      online: true,
      disabled: false,
      engines: [
        { runtime: 'claude-code', ready: true, reason: null },
        { runtime: 'codex', ready: true, reason: null },
        { runtime: 'opencode', ready: false, reason: 'not_installed' },
        { runtime: 'pi', ready: false, reason: 'not_authenticated' },
      ],
      reportedAt: iso(5 * 60_000),
    },
  ],
  modelProfile: null,
  fallbackRuntime: 'codex',
  fallbackModelProfile: null,
  limits: {
    turnsPerUserPer10Min: 20,
    userDailyTokens: 400000,
    dailyTokens: null,
    monthlyCostUsd: 50,
    maxToolCallsPerTurn: 12,
  },
  version: 4,
  updatedBy: null,
  updatedAt: iso(2 * DAY),
};

export const ACC_CHAT_STATUS = {
  enabled: true,
  available: true,
  code: null,
  message: null,
  worker: { id: 'w1', name: 'atlas-win-01', online: true },
  runtime: 'claude-code',
  model: 'sonnet',
  fallback: false,
  limit: null,
  limits: { turnsPerUserPer10Min: 20, userDailyTokens: 400000 },
  input: null,
};

export const ROUTES: ScreenRoutes = {
  '/auth/devices': (_u, m) => (m === 'GET' ? ACC_TRUSTED : undefined),
  '/notifications/push': (_u, m) => (m === 'GET' ? ACC_PUSH : undefined),
  '/notifications/preferences': (_u, m) => (m === 'GET' ? ACC_PREFS : undefined),
  '/chat/knowledge/preferences': (_u, m) => (m === 'GET' ? ACC_KNOWLEDGE_PREFS : undefined),
  '/chat/settings': (_u, m) => (m === 'GET' ? ACC_CHAT_SETTINGS : undefined),
  '/coolify-sso/config': () => ({ enabled: true, url: 'https://coolify.example' }),
  '/memory-records/personal': () => ({ items: [] }),
};
