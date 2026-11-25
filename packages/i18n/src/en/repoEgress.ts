import { plural } from '../plural.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/repoEgress.js';

/** p14-repo-egress: Projects → Policy → "Network access" of a repository project's jobs. */
export default {
  title: 'Network access',
  sub: 'Which addresses the jobs of this project (npm install, pip install, git clone … run by the agents) may reach.',
  loading: 'Network access',
  modeLegend: 'Scope',
  modes: {
    none: {
      label: 'Off (model APIs only)',
      description:
        'Jobs reach only the model provider (Anthropic, OpenAI) and the job’s MCP servers; npm install, pip install or git clone do not work.',
    },
    allowlist: {
      label: 'Allowed only',
      description: 'The model APIs plus the ready-made groups selected below and the addresses you add.',
    },
    web: {
      label: 'Whole public web',
      description:
        'Any public address on port 443. What jobs read from the web is untrusted data; choose it only if you trust every job of this project.',
    },
  },
  recommendedBadge: 'Recommended',
  recommend:
    'Recommended: “Allowed only” with the package registries — jobs can install dependencies, the rest of the internet stays closed.',
  applyRecommended: 'Apply the recommendation',
  presetsTitle: 'Ready-made groups',
  presetGroups: {
    registries: 'Package registries',
    code: 'Code hosting',
  },
  presets: {
    npm: 'npm / Yarn',
    pypi: 'PyPI (pip, uv)',
    crates: 'crates.io (Cargo)',
    go: 'Go module proxy',
    maven: 'Maven Central / Gradle',
    github: 'GitHub',
    gitlab: 'GitLab',
  },
  presetHosts: (p: { hosts: string }) => `Hosts: ${p.hosts}`,
  hostsTitle: 'More addresses',
  hostsNone: 'No more addresses.',
  hostLabel: 'Add an address (host or host:port)',
  hostPlaceholder: 'cdn.example.com',
  add: 'Add',
  remove: (p: { host: string }) => `Remove ${p.host}`,
  problems: {
    empty: 'Enter an address.',
    format: 'Enter a lower-case domain name (cdn.example.com or git.example.com:2222).',
    ip: 'IP addresses are not allowed; use a domain name.',
    internal: 'Local and internal names (localhost, .local, .internal …) are always refused.',
    port: 'The port must be between 1 and 65535.',
    duplicate: 'This address is already listed.',
    tooMany: 'At most 48 more addresses.',
  },
  emptyAllowlist: 'No group or address selected: this setting acts like “Off”.',
  floor:
    'LAN, private, loopback, link-local, CGNAT and cloud metadata addresses (such as 169.254.169.254) are refused in every scope; the model APIs are always reachable.',
  profiles:
    'Applies to the host and container profiles. In the runtime-sandbox profile the agent’s commands have no network at all. A refused request gets a 403 whose body names this setting.',
  reach: {
    none: 'Jobs can reach the model APIs only.',
    allowlist: (p: { n: number }) =>
      `Jobs can reach the model APIs and ${String(p.n)} ${plural('en', p.n, { one: 'address', other: 'addresses' })}.`,
    web: 'Jobs can reach the model APIs and every public address on port 443.',
  },
  effectiveTitle: 'Reachable addresses',
  unsupported: (p: { n: number; names: string }) =>
    `${String(p.n)} ${plural('en', p.n, { one: 'machine runs', other: 'machines run' })} an older Remyral version that does not apply this setting (model APIs only there): ${p.names}. Update ${plural('en', p.n, { one: 'it', other: 'them' })}.`,
  workspaceProject: 'This is a workspace project: its network access is set on its Workspace tab.',
  save: 'Save',
  stepUp: 'Enter your verification code to change the network access.',
  saved: 'Network access saved; the next jobs start with it.',
  readOnly: 'Only project owners and admins can change this setting.',
  updated: (p: { at: string; by: string }) => `Last change: ${p.at} · ${p.by}`,
} satisfies Shape<typeof tr>;
