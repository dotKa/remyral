import type { Shape } from '../shape.js';
import type tr from '../tr/githubRepos.js';

/**
 * p15-github-create-repo: Remyral opens a private GitHub repository and links it to a project — Settings → Integrations
 * → GitHub → "GitHub account" (account authorization, a fine-grained token as the fallback), Projects → Repository →
 * "Open a new private repo on GitHub", the new project wizard's option and the chat card (`github_repo`).
 */
export default {
  accounts: {
    title: 'GitHub account',
    sub: 'To open repositories in a personal GitHub account, let Remyral act for that account once. The token is kept only on the master, encrypted; it never reaches the machines or the browser.',
    authorize: 'Authorize the GitHub account',
    reauthorize: 'Authorize again',
    authorizeHint:
      'You go to GitHub, choose “Authorize” for the connected GitHub App and come back here. The App needs the “Administration: Read and write” permission.',
    stepUpAuthorize: 'Verification code to authorize the GitHub account',
    noSecret: 'The connected App has no client secret on this master; use the token below.',
    none: 'No GitHub account is authorized yet.',
    kinds: {
      app_user: 'GitHub App authorization',
      pat: 'Personal access token',
    },
    expires: (p) => `Valid until ${p.at}`,
    renews: 'Renewed automatically when it expires',
    noExpiry: 'No expiry',
    unusable: 'This authorization can no longer be used: authorize the account again.',
    remove: 'Remove',
    removeConfirm: (p) =>
      `Remove the authorization of ${p.login} from Remyral? You can also revoke it on GitHub → Settings → Applications.`,
    stepUpRemove: 'Verification code to remove the GitHub account',
    removed: 'The account was removed.',
    authorized: (p) => `${p.login} is authorized. Repositories can now be opened in this account.`,
    pat: {
      toggle: 'Connect with a token (fallback)',
      label: 'Fine-grained personal access token',
      hint: 'Starts with “github_pat_”. Repository access: All repositories; Repository permissions → Administration: Read and write. Kept only on the master, encrypted, and never shown again.',
      save: 'Save the token',
      stepUp: 'Verification code to save the token',
      saved: (p) => `The token for ${p.login} was saved.`,
    },
    owners: 'Where repositories can be opened',
    ownerType: {
      User: 'personal account',
      Organization: 'organization',
    },
    methods: {
      installation: 'with the GitHub App installation',
      app_user: 'with the authorized account',
      pat: 'with the personal access token',
    },
    blocked: {
      installation_suspended: 'The GitHub App installation is suspended.',
      administration_missing:
        'The GitHub App lacks “Administration: Read and write”. Add it in the App settings, accept it on the installation, then “Refresh installations”.',
      permissions_unknown: 'The installation’s permissions have not been read yet: “Refresh installations”.',
      user_authorization_missing: 'Personal account: “Authorize the GitHub account” first.',
      user_authorization_expired: 'The account’s authorization has expired: authorize it again.',
    },
  },
  callback: {
    title: 'GitHub account',
    purpose: 'Finishing the authorization GitHub returned.',
    working: 'Authorizing the GitHub account',
    stepUp: 'Verification code to finish authorizing the GitHub account',
  },
  create: {
    open: 'Open a new private repo on GitHub',
    title: 'New repository on GitHub',
    sub: 'Remyral opens the repository, adds it to the GitHub App installation and links it to this project.',
    owner: 'Owner',
    name: 'Repository name',
    nameHint: 'Letters, digits, “.”, “_” and “-”; no spaces.',
    nameInvalid:
      'A repository name may contain only letters, digits, “.”, “_” and “-” (at most 100, without “.git”).',
    description: 'Description (optional)',
    private: 'Private (recommended)',
    autoInit: 'First commit with a README (the base branch exists at once)',
    gitignore: '.gitignore template',
    gitignoreNone: 'None',
    link: (p) => `Link to project ${p.project}`,
    replaceLink: (p) => `Replace the project’s current repository (${p.current})`,
    submit: 'Open the repository',
    stepUp: 'Verification code to open a repository on GitHub',
    loading: 'Loading the GitHub options',
    noOwner:
      'Remyral cannot open a repository anywhere yet. Authorize the account or give the App the permission in Settings → Integrations → GitHub.',
    toSettings: 'Go to the GitHub settings',
    created: (p) => `${p.name} was opened.`,
    linked: (p) => `Linked to project ${p.project}; the git flow runs on the base branch.`,
    notLinked: 'The repository was opened but could not be linked to the project.',
    openOnGitHub: 'Open on GitHub',
    warnings: {
      not_in_installation:
        'The GitHub App installation cannot reach the repository: add it to the installation in GitHub → Settings → Applications → Configure.',
      empty_repository: 'The repository is empty: the base branch appears with the first push.',
      link_failed: 'It could not be linked to the project.',
    },
    cancel: 'Cancel',
  },
  wizard: {
    offer: 'Open a private repo on GitHub and link it once the project exists',
    offerHint: 'You choose the repository name and owner in the next step.',
  },
  card: {
    label: 'GitHub repository',
    kind: 'GitHub repository',
    repository: 'Repository',
    visibility: 'Visibility',
    private: 'private',
    public: 'public',
    method: 'How',
    initial: 'First commit',
    initialValue: (p) =>
      p.readme
        ? p.gitignore === ''
          ? 'README'
          : `README + .gitignore (${p.gitignore})`
        : 'none (empty repository)',
    project: 'Project',
    replaces: 'Replaces',
    linkOnly: 'The existing repository is linked; no new repository is opened.',
    note: 'The repository is opened on GitHub, added to the App installation and linked to the project. No token is on the card.',
  },
} satisfies Shape<typeof tr>;
