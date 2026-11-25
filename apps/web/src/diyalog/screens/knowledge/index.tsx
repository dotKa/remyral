import type { ReactNode } from 'react';
import { matchContext } from './contextRoutes';
import { matchSkillsAudit } from './skillsAuditRoutes';

/**
 * p12-diyalog wave 2 (W3): Yetenekler (`/skills`), Denetim (`/audit`) and Bağlam (`/context`) in the Diyalog
 * language. `/settings/context` is the same context screen inside the settings frame (`screens/settings`).
 * A matcher returns null for paths it does not own (the shell then leaves the path to the route table).
 */
export function matchKnowledge(pathname: string): ReactNode | null {
  return matchSkillsAudit(pathname) ?? matchContext(pathname);
}
