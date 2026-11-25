// p14-web-perf: a module of its own so the Diyalog cards do not load the classic approvals page.

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'git.push_protected': 'Push to protected branch',
  'git.merge': 'Merge to protected branch',
  'git.force_push': 'Force push',
  deploy: 'Deploy',
  'fs.delete_outside_workspace': 'Delete outside workspace',
  'network.egress_non_allowlisted': 'Network access outside allowlist',
  'secret.read': 'Read a secret',
  'runtime.dangerous_tool': 'Sensitive tool call',
  'job.budget_increase': 'Raise job budget',
  // p5-machine-admin (ADR-0021): one elevated command of a machine administration job.
  'machine.admin': 'Elevated machine command (root/Administrator)',
  // p14-mcp-core (ADR-0054): a tool of an external MCP server whose policy says "ask".
  'tool.mcp': 'External MCP tool call',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
