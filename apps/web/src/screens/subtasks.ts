/**
 * Projects → Policy → Sub-jobs (p8-orchestration, ADR-0031, docs/design/p8-orchestration.md §3.1). Whether the agents
 * of this project's jobs may hand parts of their work to other agent jobs (`request_subtask`), and which runtimes such
 * agent-chosen work (sub-jobs and planned workflow tasks) may use besides the requesting job's own. Changing it needs
 * an admin and a fresh authenticator code; it is audited and owners/admins are notified.
 */

export const DELEGATION_RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'] as const;
