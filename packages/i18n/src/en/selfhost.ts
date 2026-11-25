import type { Shape } from '../shape.js';
import type tr from '../tr/selfhost.js';

/**
 * p16-selfhost-onboarding (ADR-0063): the first owner (`/setup`, setup token), the owners' setup wizard
 * (`/onboarding`), the wizard hint on empty screens and the "Update available" band.
 */
export default {
  setup: {
    step: 'First-time setup',
    title: 'Create the owner account',
    description:
      'Enter the one-time setup token the server showed once during installation. This account becomes the owner of Remyral.',
    token: 'Setup token',
    tokenHint: 'Starts with rst_. Lost it? remyral-ctl setup-token on the server prints a new one.',
    tokenRequired: 'Enter the setup token.',
    username: 'Username',
    usernameHint:
      '3–32 characters: a lower-case letter first, then lower-case letters, digits, dot, underscore, dash.',
    usernameRequired: 'Choose a username.',
    password: 'Password',
    passwordHint: (p: { min: number }) =>
      `At least ${String(p.min)} characters; use a long password from your password manager.`,
    confirm: 'Password (again)',
    tooShort: (p: { min: number }) => `Use at least ${String(p.min)} characters.`,
    mismatch: 'The passwords do not match.',
    submit: 'Create the owner account',
    busy: 'Creating…',
    doneTitle: 'Account ready',
    doneText: (p: { username: string }) =>
      `${p.username} was created. Sign in now: the first sign-in connects your authenticator app and shows the recovery codes to keep.`,
    signIn: 'Sign in',
    loginLink: 'First-time setup: create the owner account',
    alreadyDone: 'This installation has an owner already; sign in.',
  },
  wizard: {
    title: 'Setup wizard',
    purpose: 'Get the new installation ready in a few steps. Skip any step and come back later.',
    progress: (p: { done: number; total: number }) => `${String(p.done)}/${String(p.total)} steps`,
    stepsLabel: 'Steps',
    loading: 'Loading the setup status…',
    what: 'the setup status',
    back: 'Back',
    next: 'Continue',
    skip: 'Skip this step',
    markDone: 'Mark as done',
    undo: 'Clear the mark',
    finished: 'Setup is complete. The wizard is no longer shown.',
    reopen: 'Open the wizard again',
    state: { todo: 'To do', done: 'Done', skipped: 'Skipped', detected: 'Detected' },
    steps: {
      account: {
        title: 'Account and verification',
        body: 'Your owner account and authenticator app are ready. Make sure the recovery codes are kept somewhere other than the phone (a password manager or paper in a safe).',
        link: 'Account settings',
      },
      about_you: {
        title: 'Getting to know you',
        body: 'If you like, import what your own AI assistant (Claude, ChatGPT, Gemini…) knows about you now; the agents then start with your preferences and rules. Optional: skip it and do it later under Settings → Profile → Import.',
        later: 'You can do this later under Settings → Profile → Import.',
      },
      organisation: {
        title: 'Organisation name',
        body: 'The name shown on screens and in notifications.',
        label: 'Organisation name',
        placeholder: 'e.g. Acme Software',
        save: 'Save',
        saved: 'Saved.',
      },
      domain: {
        title: 'Domain and access',
        body: 'The console’s address on the internet. Links in notification e-mails, machine install commands, the GitHub connection and webhook links use it. Type the domain here and save it; no terminal needed.',
        loading: 'Loading…',
        origin: 'Public address',
        originMissing:
          'Not set. Type the domain below and save it; notification links and machine install commands are built with it.',
        source: 'Where it comes from',
        sourceSetting: 'Saved in the setup wizard',
        sourceHost: 'The server applied the new name',
        sourceEnvironment: 'The server environment (PUBLIC_ORIGIN)',
        tls: 'TLS certificate',
        tlsValid: (p) => `Valid until ${p.until} (${String(p.days)} days)`,
        tlsExpired: (p) => `Expired on ${p.until}`,
        tlsError: (p) => `Could not be checked: ${p.detail}`,
        tlsUnknown: 'Not checked yet',
        tlsNone: 'Not checked: no public address is set',
        tlsNotPublic:
          'The certificate served is not publicly trusted (e.g. self-signed or the proxy’s default). Browsers and machines may warn.',
        reach: 'Console access',
        reachHere: 'You are using the console at this address right now; access works.',
        reachOther: (p) =>
          `You are using the console at ${p.here} right now. Open the public address in a new tab to try it.`,
        check: 'Check the certificate now',
        open: 'Open the public address',
        keys: 'Keys and expiry',
        formTitle: 'Set the domain',
        domain: 'Domain',
        domainHint: 'Just the name, without https:// or a path. Example: console.example.com',
        placeholder: 'console.example.com',
        domainInvalid: 'Enter a valid domain name (e.g. console.example.com).',
        tlsMode: 'Certificate and connection',
        tlsModes: {
          letsencrypt: {
            title: 'Let’s Encrypt',
            body: 'This server answers on ports 80 and 443 directly; Let’s Encrypt issues the certificate. The DNS record must point straight at this server.',
          },
          cloudflare: {
            title: 'Behind Cloudflare',
            body: 'The DNS record is proxied by Cloudflare (orange cloud); Cloudflare’s SSL mode is “Full”.',
          },
          proxy: {
            title: 'My own proxy',
            body: 'Your reverse proxy (e.g. nginx, a load balancer) terminates TLS and forwards to this server.',
          },
        },
        email: 'Let’s Encrypt e-mail',
        emailHint: 'Certificate expiry notices go to this address.',
        dnsTitle: 'Does DNS point at this server?',
        dnsCheck: 'Check DNS',
        dnsChecking: 'Checking…',
        dnsMatch: (p) => `Yes: the name points at this server (${p.addresses}).`,
        dnsCloudflare: (p) =>
          `The name is served through Cloudflare (${p.addresses}). Make sure the record in Cloudflare points at this server; the server cannot see behind Cloudflare from here.`,
        dnsMismatch: (p) =>
          `No: the name points at ${p.addresses}, while this server is known as ${p.expected}. Change the A (or AAAA) record at your DNS provider to this server’s address; it may take a few minutes to spread.`,
        dnsNotFound:
          'There is no DNS record for this name. Add an A (or AAAA) record pointing at this server at your DNS provider, then check again in a few minutes.',
        dnsUnknown: (p) =>
          `The name points at ${p.addresses}; there is no known server address to compare with. Make sure that address is this server.`,
        dnsError: (p) => `The DNS lookup failed (${p.detail}). Try again in a moment.`,
        managed:
          'This server was installed with remyral-ctl: when you save, the server applies the new name itself (proxy, certificate, restart). The old address keeps working until the new one is healthy; otherwise it switches back by itself.',
        unmanaged:
          'On this installation another platform routes the traffic (e.g. Coolify or your own proxy). Saving changes the address links use right away; the platform’s operator does the routing.',
        route: (p) =>
          `To route on that platform: ${p.origin} must reach this console (the web app, the API, machine connections and webhook paths), with a TLS certificate valid for that name.`,
        save: 'Save',
        saveApply: 'Save and apply',
        saving: 'Saving…',
        saved: (p) => `Saved: links now use ${p.origin}.`,
        stepUpReason: 'Change the console’s domain',
        clear: 'Use the server environment’s address again',
        cleared: 'The saved address was removed; the server environment’s address is used.',
        request: {
          pending: (p) => `${p.domain} was handed to the server and is waiting… (a minute at most)`,
          applying: (p) =>
            `Applying… the proxy is being set up for ${p.domain}, the certificate issued and the health checked; this can take a few minutes. The console may restart briefly meanwhile.`,
          applied: (p) => `Ready: the console now runs at ${p.domain}.`,
          rolled_back: (p) => `Error: ${p.detail}. Switched back to the old address.`,
          failed: (p) => `Error: ${p.detail}`,
          refused: (p) => `The server refused the request: ${p.detail}`,
          expired:
            'The server did not pick the request up in time. The remyral-ctl applier on the server may not be running (remyral-ctl status).',
          cancelled: 'The request was withdrawn.',
        },
        goNew: 'Go to the new address',
        cancel: 'Cancel',
      },
      security: {
        title: 'Security preset',
        body: 'Choose when an authenticator code is asked for and how freely agents work. A new install starts on Balanced. Free removes the code for everything outside the safe core (machine administration, removing the sandbox, production deploys, credentials); choose it only for a single-person, closed installation. You can change single values later in Settings → Security.',
        apply: 'Choose this preset',
        current: 'Selected now',
        applied: (p: { name: string }) => `${p.name} applied.`,
        more: 'All security settings',
      },
      machine: {
        title: 'First machine',
        body: 'Agents run on your machines; the server only manages them. Open a terminal on the machine and run the command for its system. Once it connects, the pairing request shows under Machines; approve its code.',
        os: { linux: 'Linux', macos: 'macOS', windows: 'Windows' },
        download: 'Download',
        run: 'Run',
        noRelease:
          'No worker release is uploaded yet, so there is no install command. Upload a signed worker release in Settings → Releases.',
        open: 'Add machine screen',
        waiting: 'Waiting for an approved machine…',
      },
      git: {
        title: 'Git connection',
        body: 'Jobs fetch the repository from here and propose their changes here. Connect GitHub, GitLab or Bitbucket; tokens stay encrypted on the server and are never given to agents.',
        github: 'Connect GitHub',
        gitlab: 'Connect GitLab',
        bitbucket: 'Connect Bitbucket',
      },
      integrations: {
        title: 'Optional integrations',
        body: 'Coolify for deploys, Cloudflare for sites and DNS, SMTP for e-mail notifications. None is required; skip now and add them later.',
        coolify: 'Coolify',
        cloudflare: 'Cloudflare',
        smtp: 'E-mail (SMTP)',
      },
      project: {
        title: 'First project',
        body: 'A project keeps a repository, its rules and its memory together. Create a project and pick its repository.',
        open: 'Projects',
      },
      sample_job: {
        title: 'Sample job: summarise the README',
        body: 'Start a small job to see everything work end to end: the agent reads the repository’s README and summarises it, changing nothing.',
        prompt:
          "Read this repository's README and summarise the project in five bullet points. Do not change any file.",
        start: 'Prepare the sample job',
        waiting: 'Waiting for a job that succeeds…',
        jobs: 'Jobs',
      },
      done: {
        title: 'You are ready',
        body: 'Setup is done. From here, ask for work in Chat or start it from Jobs.',
        chat: 'Chat',
        jobs: 'Jobs',
        machines: 'Machines',
        settings: 'Settings',
        finish: 'Finish the wizard',
      },
    },
  },
  nudge: {
    title: 'Finish the setup',
    text: (p: { done: number; total: number }) =>
      `${String(p.done)}/${String(p.total)} steps of the setup wizard are done.`,
    open: 'Open the wizard',
    empty: 'The setup wizard guides you through this step.',
  },
  update: {
    banner: (p: { version: string }) => `Update available: Remyral ${p.version}`,
    notes: 'Notes',
    updateNow: 'Update now',
    dismiss: 'Hide for this version',
    dialogTitle: (p: { version: string }) => `Remyral ${p.version}`,
    current: (p: { version: string }) => `Installed version: ${p.version}`,
    machineFloor: (p: { version: string }) =>
      `Machines need at least remyral-worker ${p.version}; they update themselves.`,
    breaking: 'Breaking changes',
    command: 'The upgrade runs on the server',
    commandHint:
      'On a server installed with remyral-ctl, “Update now” has the server do it; otherwise connect to the server and run this command. A backup is taken first; if the health check fails it goes back to the old version.',
    close: 'Close',
  },
} satisfies Shape<typeof tr>;
