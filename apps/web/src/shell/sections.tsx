import type { ReactNode } from 'react';
import {
  ApprovalsIcon,
  AuditIcon,
  AutomationsIcon,
  ChatIcon,
  ContextIcon,
  HomeIcon,
  JobsIcon,
  MachinesIcon,
  OutputsIcon,
  ProjectsIcon,
  SettingsIcon,
  SkillsIcon,
  UptimeIcon,
  UsageIcon,
} from '../components/icons';

/**
 * p6-ui-refactor §4: three unlabeled sidebar groups — daily work, machines & projects, knowledge & governance —
 * and Settings pinned at the bottom.
 */
export type NavGroup = 'daily' | 'resources' | 'knowledge' | 'settings';

export interface Section {
  readonly path: string;
  readonly label: string;
  readonly icon: (p: { readonly className?: string }) => ReactNode;
  readonly title: string;
  readonly summary: string;
  /** Ids of the planned work items that fill this section. */
  readonly tasks: readonly string[];
  readonly group: NavGroup;
  /** Shown in the phone bottom bar (Home, Chat, Jobs, Approvals); the rest are under "More". */
  readonly bottomBar?: boolean;
}

export const SECTIONS: readonly Section[] = [
  {
    path: '/',
    label: 'Home',
    icon: HomeIcon,
    title: 'Home',
    summary: 'What needs you and what is running.',
    tasks: ['p6-ui-foundation'],
    group: 'daily',
    bottomBar: true,
  },
  {
    path: '/chat',
    label: 'Chat',
    icon: ChatIcon,
    title: 'Chat',
    summary:
      'Ask the operations assistant about machines, projects, jobs, approvals and usage. It works with your permissions and only drafts changes — you confirm them.',
    tasks: ['p5-ops-chat'],
    group: 'daily',
    bottomBar: true,
  },
  {
    path: '/jobs',
    label: 'Jobs',
    icon: JobsIcon,
    title: 'Jobs',
    summary: 'Compose, schedule and supervise agent jobs, with live logs, diffs and cancellation.',
    tasks: ['p5-composer', 'p5-live', 'p4-job-store'],
    group: 'daily',
    bottomBar: true,
  },
  {
    path: '/outputs',
    label: 'Outputs',
    icon: OutputsIcon,
    title: 'Outputs',
    summary:
      'Sites your jobs published, the files they produced and your notes — preview, download, pin, annotate.',
    tasks: ['p6-outputs'],
    group: 'daily',
  },
  {
    path: '/uptime',
    label: 'Uptime',
    icon: UptimeIcon,
    title: 'Uptime',
    summary:
      'Is what you deployed reachable? Monitors of your sites, services, Pages deployments and Coolify apps.',
    tasks: ['p8-uptime'],
    group: 'daily',
  },
  {
    path: '/automations',
    label: 'Automations',
    icon: AutomationsIcon,
    title: 'Automations',
    summary:
      'Jobs that start on a schedule, on GitHub events, on a signed webhook call or after another automation.',
    tasks: ['p6-automations'],
    group: 'daily',
  },
  {
    path: '/approvals',
    label: 'Approvals',
    icon: ApprovalsIcon,
    title: 'Approvals',
    summary:
      'Pending human approvals for protected merges, destructive and network-sensitive actions. Approving will ask for a fresh authenticator code.',
    tasks: ['p5-live', 'p4-approvals'],
    group: 'daily',
    bottomBar: true,
  },
  {
    path: '/machines',
    label: 'Machines',
    icon: MachinesIcon,
    title: 'Machines',
    summary:
      'The machines that run your agents: their status, capacity and which runtimes are ready. Add one with “Add machine”, then pair it here.',
    tasks: ['p5-fleet-ui', 'p2-pairing', 'p2-heartbeat-caps'],
    group: 'resources',
  },
  {
    path: '/projects',
    label: 'Projects',
    icon: ProjectsIcon,
    title: 'Projects',
    summary: 'Projects group jobs, members, policies, context and budgets. Every job belongs to one project.',
    tasks: ['p5-rbac-api'],
    group: 'resources',
  },
  {
    path: '/skills',
    label: 'Skills',
    icon: SkillsIcon,
    title: 'Skills',
    summary: 'Signed, versioned skill bundles assigned to projects and runtimes.',
    tasks: ['p6-skills'],
    group: 'knowledge',
  },
  {
    path: '/context',
    label: 'Context',
    icon: ContextIcon,
    title: 'Context',
    summary: 'Versioned global and project instructions and memories that agents receive with every job.',
    tasks: ['p6-context-model', 'p6-context-policy'],
    group: 'knowledge',
  },
  {
    path: '/usage',
    label: 'Usage',
    icon: UsageIcon,
    title: 'Usage and cost',
    summary:
      'Tokens, turns, time and cost by project, machine, runtime, provider and model — with where every cost comes from and what is missing. Price table and budgets.',
    tasks: ['p6-cost'],
    group: 'knowledge',
  },
  {
    path: '/audit',
    label: 'Audit',
    icon: AuditIcon,
    title: 'Audit log',
    summary: 'Search and export the tamper-evident audit trail of every privileged action and state change.',
    tasks: ['p5-search-audit'],
    group: 'knowledge',
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    title: 'Settings',
    summary: 'Your account, agents and workspace.',
    tasks: ['p5-notifications'],
    group: 'settings',
  },
];
