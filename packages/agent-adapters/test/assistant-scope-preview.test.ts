import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p20-scope-preview: rule 67 — a development preview is a service
 * with a tunnel, not a Coolify / Pages release; the user's chosen method is kept; check_work_readiness before the work
 * starts. Rules 7 / 9 / 27 point to it and to the goal-bound grant.
 */
describe('assistant previews and readiness (p20-scope-preview)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 67: preview via start_service + tunnel; a release only when asked; keep the chosen method', () => {
    const r = rule(67);
    expect(r).toContain('start_service');
    expect(r).toContain('Cloudflare Tunnel yeterli');
    expect(r).toContain('only when the user asks to publish');
    expect(r).toContain('never swap it for another one (rule 60)');
    expect(r).not.toMatch(/[âîûÂÎÛ]/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('rule 67: check_work_readiness before the work — prepare runs, ask is ONE question, blocked stops', () => {
    const r = rule(67);
    expect(r).toContain('BEFORE starting a job or a service, call check_work_readiness');
    expect(r).toContain('cloudflared');
    expect(r).toContain('Run its prepare calls yourself');
    expect(r).toContain('ONE question');
    expect(r).toContain('do not start');
  });

  it('rules 7, 9 and 27 point to the readiness check and the goal-bound grant', () => {
    expect(rule(7)).toContain('check_work_readiness (rule 67)');
    expect(rule(9)).toContain('goalScope');
    expect(rule(9)).toContain('ONE card');
    expect(rule(27)).toContain('autonomy.goalGrants');
    expect(rule(27)).toContain('Hedefe bağlı yetki');
  });

  it('the tool descriptions agree', () => {
    expect(ASSISTANT_TOOLS.start_service.description).toContain('rule 67');
    expect(ASSISTANT_TOOLS.coolify_create_app.description).toContain('start_service with a tunnel');
    expect(ASSISTANT_TOOLS.draft_deploy.description).toContain('start_service with a tunnel');
    expect(ASSISTANT_TOOLS.check_work_readiness.kind).toBe('read');
    expect(ASSISTANT_TOOLS.draft_tool_install.input.tool.options).toContain('cloudflared');
    expect(ASSISTANT_TOOLS.change_settings.description).toContain('goalGrants');
  });
});
