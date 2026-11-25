import type { Shape } from '../shape.js';
import type tr from '../tr/nav.js';

export default {
  landmark: 'Diyalog',
  home: 'Home',
  homeLink: 'Remyral, home',
  chat: 'Chat',
  needs: 'Needs you',
  plans: 'Plans',
  jobs: 'Jobs',
  workflows: 'Workflows',
  automations: 'Automations',
  machines: 'Machines',
  outputs: 'Outputs',
  usage: 'Usage',
  projects: 'Projects',
  settings: 'Settings',
  all: 'All',
  unit: {
    unread: 'unread',
    waiting: 'waiting',
    pairing: 'awaiting pairing',
  },
  withCount: (p) => `${p.label}, ${String(p.n)} ${p.unit}`.trim(),
  search: (p) => `Search (${p.keys})`,
  searchTitle: (p) => `Go to pages, chats and jobs; search with AI (${p.keys})`,
  sections: {
    uptime: 'Uptime',
    automations: 'Automations',
    approvals: 'Approvals',
    skills: 'Skills',
    context: 'Context',
    audit: 'Audit',
  },
  shortcuts: 'Keyboard shortcuts',
  shortcutsTitle: 'Keyboard shortcuts (?)',
} satisfies Shape<typeof tr>;
