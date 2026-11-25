import type { Shape } from '../shape.js';
import type tr from '../tr/egress.js';

/** p14-workflow-engine 14.3 (ADR-0055 K1): Projects → Policy → "HTTP allowlist" of workflow HTTP and e-mail nodes. */
export default {
  title: 'HTTP allowlist',
  sub: 'Which addresses the HTTP request and e-mail nodes of workflows may reach.',
  loading: 'HTTP allowlist',
  modeLegend: 'Scope',
  modes: {
    open: {
      label: 'Open (recommended: limit with a list)',
      description:
        'Any public address may be reached. Listed addresses are shown as suggestions in the editor.',
    },
    allowlist: {
      label: 'Listed only',
      description: 'HTTP and e-mail nodes may reach only the addresses below.',
    },
  },
  floor:
    'LAN, private, loopback, link-local and cloud metadata addresses (such as 169.254.169.254) are always refused; requests always leave from a machine, never from the server.',
  openPorts:
    'In open scope, a port other than 80, 443, 8080 and 8443 can be used only when listed as “host:port”.',
  hostsTitle: 'Addresses',
  hostsNone: 'No addresses listed.',
  hostsEmptyAllowlist: 'With “Listed only” and an empty list, no HTTP or e-mail node can run.',
  hostLabel: 'Add an address (host or host:port)',
  hostPlaceholder: 'api.example.com',
  add: 'Add',
  remove: (p: { host: string }) => `Remove ${p.host}`,
  problems: {
    empty: 'Enter an address.',
    format: 'Enter a lower-case domain name (api.example.com or api.example.com:8443).',
    ip: 'IP addresses are not allowed; use a domain name.',
    internal: 'Local and internal names (localhost, .local, .internal …) are always refused.',
    port: 'The port must be between 1 and 65535.',
    duplicate: 'This address is already listed.',
    tooMany: 'At most 64 addresses.',
  },
  save: 'Save',
  stepUp: 'Enter your verification code to change the HTTP allowlist.',
  saved: 'HTTP allowlist saved.',
  readOnly: 'Only project owners and admins can change this list.',
  updated: (p: { at: string; by: string }) => `Last change: ${p.at} · ${p.by}`,
} satisfies Shape<typeof tr>;
