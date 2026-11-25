import {
  type AssistantRuntime,
  type ChatLimits,
  type ChatSettings,
  isAssistantRuntime,
} from '../../api/chat';

/**
 * Settings → Chat (p5-ops-chat, admin): the kill switch, which worker runs the assistant (with its own
 * runtime login or vault credential), the model profile and the limits that make up the Chat budget line.
 * Saving needs a fresh authenticator code; turning chat off stops running answers.
 */

export interface ChatSettingsForm {
  enabled: boolean;
  workerId: string;
  runtime: AssistantRuntime;
  modelProfile: string;
  /** p11-usage-limit-fallback: '' = no fallback engine. */
  fallbackRuntime: AssistantRuntime | '';
  fallbackModelProfile: string;
  turns: string;
  userDaily: string;
  daily: string;
  monthlyCost: string;
  toolCalls: string;
}

export function toChatForm(s: ChatSettings): ChatSettingsForm {
  const n = (v: number | null): string => (v === null ? '' : String(v));
  return {
    enabled: s.enabled,
    workerId: s.workerId ?? '',
    runtime: isAssistantRuntime(s.runtime) ? s.runtime : 'claude-code',
    modelProfile: s.modelProfile ?? '',
    fallbackRuntime:
      s.fallbackRuntime !== null && isAssistantRuntime(s.fallbackRuntime) ? s.fallbackRuntime : '',
    fallbackModelProfile: s.fallbackModelProfile ?? '',
    turns: String(s.limits.turnsPerUserPer10Min),
    userDaily: n(s.limits.userDailyTokens),
    daily: n(s.limits.dailyTokens),
    monthlyCost: n(s.limits.monthlyCostUsd),
    toolCalls: String(s.limits.maxToolCallsPerTurn),
  };
}

export function chatLimitsOf(f: ChatSettingsForm): ChatLimits | string {
  const req = (v: string, name: string): number | string => {
    const x = Number(v);
    return v.trim() === '' || !Number.isInteger(x) || x < 1 ? `${name} must be a whole number ≥ 1.` : x;
  };
  const opt = (v: string, name: string, int = true): number | null | string => {
    if (v.trim() === '') return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0 || (int && (!Number.isInteger(x) || x < 1)))
      return `${name} must be empty or a positive number.`;
    return x;
  };
  const turns = req(f.turns, 'Turns per 10 minutes');
  const tools = req(f.toolCalls, 'Tool calls per turn');
  const userDaily = opt(f.userDaily, 'Daily tokens per user');
  const daily = opt(f.daily, 'Daily tokens (everyone)');
  const cost = opt(f.monthlyCost, 'Monthly cost', false);
  for (const v of [turns, tools, userDaily, daily, cost]) if (typeof v === 'string') return v;
  return {
    turnsPerUserPer10Min: turns as number,
    maxToolCallsPerTurn: tools as number,
    userDailyTokens: userDaily as number | null,
    dailyTokens: daily as number | null,
    monthlyCostUsd: cost as number | null,
  };
}
