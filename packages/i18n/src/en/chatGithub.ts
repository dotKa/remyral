import type { Shape } from '../shape.js';
import type tr from '../tr/chatGithub.js';

/**
 * p17-chat-github: conversation titles from meaning (the short notice in the thread), the create-project card from
 * the chat and several GitHub App connections (Settings → Integrations → GitHub).
 */
export default {
  title: {
    renamed: (p: { title: string }) => `Conversation renamed: “${p.title}”`,
  },
  project: {
    label: 'New project',
    kind: 'Create project',
    id: 'Project id',
    name: 'Name',
    description: 'Description',
    type: 'Kind',
    typeRepository: 'Repository project',
    typeWorkspace: 'Workspace (no repository)',
    repository: 'Repository',
    baseBranch: 'Base branch',
    connection: 'GitHub connection',
    dnsZone: 'Allowed DNS zone',
    egress: 'Network access',
    knowledge: 'Project knowledge',
    knowledgeValue: (p: { search: boolean; memory: boolean }) =>
      `${p.search ? 'Search on' : 'Search off'} · ${p.memory ? 'Memory suggestions on' : 'Memory suggestions off'}`,
    note: 'Nothing is created until you confirm. Confirming creates the project and links the repository and DNS zone, if any (owners / administrators).',
  },
  connections: {
    title: 'GitHub Apps',
    sub: 'A separate, private GitHub App per account or organization. Only installations you accept are used.',
    guideSummary: 'Why a separate private App per account?',
    guideWhy:
      'A private GitHub App can only be installed on the account or organization that owns it. For another organization’s repositories, connect a separate private App in that organization.',
    guideSteps: {
      s1: 'In “Add App” choose the organization and confirm the App on GitHub.',
      s2: 'Install the App on that organization on GitHub (“Install on repositories” on the App’s card).',
      s3: 'Use “Refresh installations” on the App’s card to see it and “Accept” to put it to use.',
    },
    guidePublic:
      'Anyone can install a public App: webhook events of unknown accounts arrive and their installations wait for acceptance. That is why a private App is recommended.',
    pending: 'Waiting for acceptance',
    accepted: 'Accepted',
    accept: 'Accept',
    withdraw: 'Withdraw acceptance',
    pendingHint:
      'New installations are not used until accepted (repository list, project link, access tokens).',
    stepUpAccept: 'Accept the GitHub installation — enter a current authenticator code.',
    stepUpWithdraw: 'Withdraw the GitHub installation’s acceptance — enter a current authenticator code.',
    acceptedToast: (p: { account: string }) => `Installation of ${p.account} accepted`,
    withdrawnToast: (p: { account: string }) => `Acceptance of ${p.account}’s installation withdrawn`,
    envSource: 'From the environment (read-only)',
    envHint: 'Comes from the server environment (GITHUB_APP_ID); it cannot be changed in the panel.',
    keyUnusable: 'Key cannot be used',
    rename: 'Rename',
    labelField: 'Connection name',
    save: 'Save',
    cancel: 'Cancel',
    stepUpRename: 'Rename the GitHub connection — enter a current authenticator code.',
    remove: 'Remove connection',
    removeConfirm: 'Remove',
    removeTitle: 'Remove this connection?',
    removeBody: (p: { n: number; projects: string }) =>
      p.n === 0
        ? 'Its key and installations are deleted. The App stays on GitHub; delete it there yourself.'
        : `Its key and installations are deleted; ${p.projects} can no longer use this App. The App stays on GitHub.`,
    stepUpRemove: 'Remove the GitHub connection — enter a current authenticator code.',
    removed: 'Connection removed',
    add: 'Add App',
    addTitle: 'New GitHub App',
    labelOptional: 'Connection name (optional)',
    limit: (p: { n: number }) => `At most ${String(p.n)} Apps can be added.`,
    stepUpAdd: 'Add a GitHub App connection — enter a current authenticator code.',
    appsCount: (p: { n: number }) => (p.n === 1 ? '1 App' : `${String(p.n)} Apps`),
    counts: (p: { installations: number; projects: number }) =>
      `${String(p.installations)} ${p.installations === 1 ? 'installation' : 'installations'} · ${String(p.projects)} ${p.projects === 1 ? 'project' : 'projects'}`,
    pendingPill: 'Installation waiting',
    defaultApp: 'Default App',
    defaultHint:
      'Repositories without a chosen connection and the “GitHub account” authorization use this App. Everything else on each App’s card works for that App only.',
    webhookSet: 'set up',
    wideTitle: 'All Apps',
    wideSub: 'The action here applies to every connected App, not to one.',
    syncAll: 'Refresh installations of all Apps',
    syncAllHint:
      'Re-reads every App’s installations from GitHub, Apps from the environment included. For one App use “Refresh installations” on its card.',
  },
} satisfies Shape<typeof tr>;
