import { z } from 'zod';

/**
 * GitHub event matching and extraction for `github` automations (docs/design/p6-automations.md §3, §9). Pure.
 *
 * The payload is attacker-influenced (titles, bodies, comments, commit messages, branch names). Nothing here
 * interprets it beyond allow-listed fields: the result is a bounded object that reaches a job only as fenced data,
 * plus a display summary. Trust: a pull request from a fork, or content authored by someone who is not an owner,
 * member or collaborator of the repository, is `untrusted`.
 */

export const GITHUB_EVENTS = [
  'pull_request',
  'push',
  'issues',
  'issue_comment',
  // p6-automations-next (design §18.5)
  'pull_request_review',
  'release',
  'workflow_run',
  'check_suite',
] as const;
export type GitHubEvent = (typeof GITHUB_EVENTS)[number];

/** Actions a trigger listens to when it names none. */
export const DEFAULT_ACTIONS: Readonly<Record<Exclude<GitHubEvent, 'push'>, readonly string[]>> = {
  pull_request: ['opened', 'synchronize', 'reopened'],
  issues: ['opened'],
  issue_comment: ['created'],
  pull_request_review: ['submitted'],
  release: ['published'],
  workflow_run: ['completed'],
  check_suite: ['completed'],
};

export const KNOWN_ACTIONS: Readonly<Record<Exclude<GitHubEvent, 'push'>, readonly string[]>> = {
  pull_request: [
    'opened',
    'synchronize',
    'reopened',
    'closed',
    'edited',
    'labeled',
    'unlabeled',
    'ready_for_review',
    'converted_to_draft',
    'assigned',
    'review_requested',
  ],
  issues: ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled', 'assigned'],
  issue_comment: ['created', 'edited'],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  release: ['published', 'created', 'released', 'prereleased', 'edited'],
  workflow_run: ['completed', 'requested', 'in_progress'],
  check_suite: ['completed', 'requested', 'rerequested'],
};

/**
 * `workflow_run` causes that need write access to the repository (or a token with it): such a run of a
 * same-repository head is trusted. Anything else (`issue_comment`, `pull_request_target`, a run started by another
 * run …) may have been started by anyone.
 */
const WRITE_CAUSES: ReadonlySet<string> = new Set([
  'push',
  'schedule',
  'workflow_dispatch',
  'release',
  'merge_group',
  'pull_request',
  'repository_dispatch',
]);
const SHA40 = /^[0-9a-f]{40}$/;

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GLOB = /^[A-Za-z0-9_.\-/*]{1,255}$/;

export const GitHubTrigger = z.strictObject({
  kind: z.literal('github'),
  repository: z.string().regex(REPO, 'owner/name'),
  event: z.enum(GITHUB_EVENTS),
  /** p6-automations-next: further events of the same trigger (distinct, without `event`). */
  additionalEvents: z.array(z.enum(GITHUB_EVENTS)).min(1).max(7).optional(),
  actions: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .min(1)
    .max(12)
    .optional(),
  /** Base branch of a pull request, branch of a push (globs: `*` within a segment, `**` across). */
  branches: z.array(z.string().regex(GLOB)).min(1).max(20).optional(),
  /** Pull requests / issues: the event's label (for `labeled`) or one of the item's labels. */
  labels: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  /** issue_comment: the comment must start with this word (e.g. `/remyral`). */
  command: z
    .string()
    .regex(/^\/?[A-Za-z0-9_.-]{1,40}$/)
    .optional(),
  /** Run for fork pull requests and non-collaborator authors (as untrusted, in the container profile). */
  allowUntrusted: z.boolean().optional(),
  /**
   * `event`: the job checks out what the event names — the PR head / pushed branch / release tag / run head of the
   * same repository; with `allowUntrusted`, an untrusted pull request's head pinned to the event's head SHA
   * (design §18.2, ADR-0026). Default: the base.
   */
  checkout: z.enum(['base', 'event']).optional(),
});
export type GitHubTrigger = z.infer<typeof GitHubTrigger>;

/** Every event a trigger listens to (`event` first). */
export function triggerEvents(t: Pick<GitHubTrigger, 'event' | 'additionalEvents'>): GitHubEvent[] {
  return [...new Set([t.event, ...(t.additionalEvents ?? [])])];
}

export function validateActions(t: GitHubTrigger): string | null {
  const extra = t.additionalEvents ?? [];
  if (new Set(extra).size !== extra.length || extra.includes(t.event)) {
    return 'additionalEvents must be distinct and must not repeat event';
  }
  const events = triggerEvents(t);
  if (t.command !== undefined && !events.includes('issue_comment'))
    return 'a command filter is only for issue_comment';
  const withActions = events.filter((e): e is Exclude<GitHubEvent, 'push'> => e !== 'push');
  if (t.actions === undefined) return null;
  if (withActions.length === 0) return 'push events have no actions';
  const known = new Set(withActions.flatMap((e) => KNOWN_ACTIONS[e]));
  const bad = t.actions.filter((a) => !known.has(a));
  if (bad.length > 0) return `unknown ${withActions.join('/')} action(s): ${bad.join(', ')}`;
  const actions = t.actions;
  const deaf = withActions.filter((e) => !actions.some((a) => KNOWN_ACTIONS[e].includes(a)));
  return deaf.length === 0 ? null : `none of the selected actions applies to ${deaf.join(', ')}`;
}

/** Glob over branch names: `*` matches within a path segment, `**` across segments. */
export function globMatch(glob: string, value: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else re += ch.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(value);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Strings clipped to `n` characters, control characters except newline/tab removed. */
export function clip(v: unknown, n: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const s = str(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const labelsOf = (v: unknown): string[] =>
  arr(v)
    .map((l) => clip(obj(l).name, 100))
    .filter((l) => l !== '')
    .slice(0, 30);
const trusted = (association: unknown): boolean => TRUSTED_ASSOCIATIONS.has(str(association));

export type GitHubMatch =
  | { readonly match: false; readonly reason: string }
  | {
      readonly match: true;
      readonly trust: 'trusted' | 'untrusted';
      /** Display summary (never an instruction). */
      readonly summary: Json;
      /** Bounded data delivered to the job as fenced untrusted data. */
      readonly data: Json;
      /** `checkout: event`: the branch / tag / commit to check out (trusted source of the same repository), else null. */
      readonly checkoutRef: string | null;
      /**
       * p6-automations-next (§18.2): `checkout: event` + `allowUntrusted` on an untrusted pull request — the PR head,
       * pinned to the event's head SHA. Never the fork's URL or branch name.
       */
      readonly checkoutPullRequest: { readonly number: number; readonly headSha: string } | null;
    };

const no = (reason: string): GitHubMatch => ({ match: false, reason });

/** The repository an event is for (`owner/name`, lower case), or null. */
export function eventRepository(payload: unknown): string | null {
  const full = str(obj(obj(payload).repository).full_name);
  return REPO.test(full) ? full.toLowerCase() : null;
}

/**
 * Does `payload` (event `event`) start `trigger`? Applies repository, event, action, branch, label and command
 * filters and the trust rule; returns the extracted data when it does.
 */
export function matchGitHubEvent(trigger: GitHubTrigger, event: string, payload: unknown): GitHubMatch {
  const events: readonly string[] = triggerEvents(trigger);
  if (!events.includes(event)) return no('another event');
  const ev = event as GitHubEvent;
  if (eventRepository(payload) !== trigger.repository.toLowerCase()) return no('another repository');
  const p = obj(payload);
  const action = str(p.action);
  const sender = clip(obj(p.sender).login, 100);
  if (ev !== 'push') {
    const actions = trigger.actions ?? DEFAULT_ACTIONS[ev];
    if (!actions.includes(action)) return no(`action ${action || '(none)'} not selected`);
  }
  switch (ev) {
    case 'pull_request':
      return pullRequest(trigger, p, action, sender);
    case 'push':
      return push(trigger, p, sender);
    case 'issues':
      return issues(trigger, p, action, sender);
    case 'issue_comment':
      return issueComment(trigger, p, action, sender);
    case 'pull_request_review':
      return pullRequestReview(trigger, p, action, sender);
    case 'release':
      return release(trigger, p, action, sender);
    case 'workflow_run':
      return workflowRun(trigger, p, action, sender);
    case 'check_suite':
      return checkSuite(trigger, p, action, sender);
  }
}

function finish(
  trigger: GitHubTrigger,
  isTrusted: boolean,
  summary: Json,
  data: Json,
  checkoutRef: string | null,
  pullHead: { readonly number: number | null; readonly headSha: string } | null = null,
): GitHubMatch {
  if (!isTrusted && trigger.allowUntrusted !== true) {
    return no('untrusted source (fork or outside author) and the automation does not allow untrusted events');
  }
  const wantsCheckout = trigger.checkout === 'event';
  return {
    match: true,
    trust: isTrusted ? 'trusted' : 'untrusted',
    summary,
    data,
    checkoutRef: wantsCheckout && isTrusted ? checkoutRef : null,
    checkoutPullRequest:
      wantsCheckout &&
      !isTrusted &&
      pullHead !== null &&
      pullHead.number !== null &&
      Number.isInteger(pullHead.number) &&
      pullHead.number > 0 &&
      SHA40.test(pullHead.headSha)
        ? { number: pullHead.number, headSha: pullHead.headSha }
        : null,
  };
}

function labelFilter(
  trigger: GitHubTrigger,
  action: string,
  eventLabel: string,
  itemLabels: string[],
): boolean {
  if (trigger.labels === undefined) return true;
  const wanted = new Set(trigger.labels.map((l) => l.toLowerCase()));
  const candidates = action === 'labeled' || action === 'unlabeled' ? [eventLabel] : itemLabels;
  return candidates.some((l) => wanted.has(l.toLowerCase()));
}

function pullRequest(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const pr = obj(p.pull_request);
  const head = obj(pr.head);
  const base = obj(pr.base);
  const headRepo = str(obj(head.repo).full_name).toLowerCase();
  const baseRepo = str(obj(base.repo).full_name).toLowerCase();
  const fork = headRepo === '' || headRepo !== baseRepo;
  const baseRef = clip(base.ref, 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, baseRef))) {
    return no(`base branch ${baseRef} not selected`);
  }
  const labels = labelsOf(pr.labels);
  const eventLabel = clip(obj(p.label).name, 100);
  if (!labelFilter(trigger, action, eventLabel, labels)) return no('label not selected');
  const number = num(pr.number ?? p.number);
  const title = clip(pr.title, 300);
  const author = clip(obj(pr.user).login, 100);
  const isTrusted = !fork && trusted(pr.author_association);
  const headRef = clip(head.ref, 255);
  return finish(
    trigger,
    isTrusted,
    { event: 'pull_request', action, number, title, branch: baseRef, actor: sender, author, fork },
    {
      event: 'pull_request',
      action,
      repository: trigger.repository,
      sender,
      ...(eventLabel === '' ? {} : { label: eventLabel }),
      pullRequest: {
        number,
        title,
        body: clip(pr.body, 16_000),
        author,
        authorAssociation: clip(pr.author_association, 40),
        url: clip(pr.html_url, 500),
        draft: pr.draft === true,
        state: clip(pr.state, 20),
        labels,
        base: { ref: baseRef, sha: clip(base.sha, 40) },
        head: { ref: headRef, sha: clip(head.sha, 40), repository: headRepo || null },
        fromFork: fork,
      },
    },
    fork ? null : headRef,
    { number, headSha: str(head.sha) },
  );
}

function push(trigger: GitHubTrigger, p: Json, sender: string): GitHubMatch {
  const ref = str(p.ref);
  if (!ref.startsWith('refs/heads/')) return no('not a branch push');
  if (p.deleted === true) return no('branch deletion');
  const branch = clip(ref.slice('refs/heads/'.length), 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, branch))) {
    return no(`branch ${branch} not selected`);
  }
  const commits = arr(p.commits)
    .slice(0, 20)
    .map((c) => {
      const o = obj(c);
      return { id: clip(o.id, 40), message: clip(o.message, 1000), author: clip(obj(o.author).name, 100) };
    });
  const after = clip(p.after, 40);
  // A push needs write access to the repository: the pushed code is the repository's own.
  return finish(
    trigger,
    true,
    { event: 'push', branch, sha: after, actor: sender, commits: arr(p.commits).length },
    {
      event: 'push',
      repository: trigger.repository,
      sender,
      branch,
      before: clip(p.before, 40),
      after,
      forced: p.forced === true,
      compare: clip(p.compare, 500),
      commits,
    },
    branch,
  );
}

function issues(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const issue = obj(p.issue);
  const labels = labelsOf(issue.labels);
  const eventLabel = clip(obj(p.label).name, 100);
  if (!labelFilter(trigger, action, eventLabel, labels)) return no('label not selected');
  const number = num(issue.number);
  const title = clip(issue.title, 300);
  const author = clip(obj(issue.user).login, 100);
  return finish(
    trigger,
    trusted(issue.author_association),
    { event: 'issues', action, number, title, actor: sender, author },
    {
      event: 'issues',
      action,
      repository: trigger.repository,
      sender,
      ...(eventLabel === '' ? {} : { label: eventLabel }),
      issue: {
        number,
        title,
        body: clip(issue.body, 16_000),
        author,
        authorAssociation: clip(issue.author_association, 40),
        url: clip(issue.html_url, 500),
        state: clip(issue.state, 20),
        labels,
      },
    },
    null,
  );
}

function issueComment(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const comment = obj(p.comment);
  const issue = obj(p.issue);
  const body = str(comment.body);
  if (trigger.command !== undefined) {
    const text = body.trimStart();
    const rest = text.slice(trigger.command.length);
    if (!text.startsWith(trigger.command) || (rest !== '' && !/^\s/.test(rest))) {
      return no('comment does not start with the command');
    }
  }
  const number = num(issue.number);
  const commenter = clip(obj(comment.user).login, 100);
  const isPullRequest = issue.pull_request !== undefined && issue.pull_request !== null;
  const isTrusted = trusted(comment.author_association) && trusted(issue.author_association);
  return finish(
    trigger,
    isTrusted,
    {
      event: 'issue_comment',
      action,
      number,
      title: clip(issue.title, 300),
      actor: sender,
      author: commenter,
      pullRequest: isPullRequest,
    },
    {
      event: 'issue_comment',
      action,
      repository: trigger.repository,
      sender,
      comment: {
        body: clip(body, 8_000),
        author: commenter,
        authorAssociation: clip(comment.author_association, 40),
        url: clip(comment.html_url, 500),
      },
      issue: {
        number,
        title: clip(issue.title, 300),
        body: clip(issue.body, 8_000),
        author: clip(obj(issue.user).login, 100),
        authorAssociation: clip(issue.author_association, 40),
        pullRequest: isPullRequest,
        url: clip(issue.html_url, 500),
      },
    },
    null,
  );
}

/** One line for lists: "pull_request opened/synchronize on owner/repo (main)". */
export function describeGitHubTrigger(t: GitHubTrigger): string {
  const events = triggerEvents(t);
  if (events.length > 1) {
    const acts = t.actions === undefined ? '' : ` (${t.actions.join('/')})`;
    const br = t.branches === undefined ? '' : ` (${t.branches.join(', ')})`;
    return `GitHub ${events.join(', ')}${acts} on ${t.repository}${br}`;
  }
  const actions = t.event === 'push' ? '' : ` ${(t.actions ?? DEFAULT_ACTIONS[t.event]).join('/')}`;
  const branches = t.branches === undefined ? '' : ` (${t.branches.join(', ')})`;
  const labels = t.labels === undefined ? '' : ` labelled ${t.labels.join(', ')}`;
  const command = t.command === undefined ? '' : ` starting with ${t.command}`;
  return `GitHub ${t.event}${actions} on ${t.repository}${branches}${labels}${command}`;
}

function pullRequestReview(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const review = obj(p.review);
  const pr = obj(p.pull_request);
  const head = obj(pr.head);
  const base = obj(pr.base);
  const headRepo = str(obj(head.repo).full_name).toLowerCase();
  const baseRepo = str(obj(base.repo).full_name).toLowerCase();
  const fork = headRepo === '' || headRepo !== baseRepo;
  const baseRef = clip(base.ref, 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, baseRef))) {
    return no(`base branch ${baseRef} not selected`);
  }
  const labels = labelsOf(pr.labels);
  if (!labelFilter(trigger, action, '', labels)) return no('label not selected');
  const number = num(pr.number);
  const title = clip(pr.title, 300);
  const reviewer = clip(obj(review.user).login, 100);
  // The review text is the reviewer's, the code the PR author's: both must be trusted (like issue_comment).
  const isTrusted = !fork && trusted(review.author_association) && trusted(pr.author_association);
  const headRef = clip(head.ref, 255);
  return finish(
    trigger,
    isTrusted,
    {
      event: 'pull_request_review',
      action,
      number,
      title,
      branch: baseRef,
      actor: sender,
      author: reviewer,
      state: clip(review.state, 40),
      fork,
    },
    {
      event: 'pull_request_review',
      action,
      repository: trigger.repository,
      sender,
      review: {
        state: clip(review.state, 40),
        body: clip(review.body, 8_000),
        author: reviewer,
        authorAssociation: clip(review.author_association, 40),
        url: clip(review.html_url, 500),
      },
      pullRequest: {
        number,
        title,
        body: clip(pr.body, 8_000),
        author: clip(obj(pr.user).login, 100),
        authorAssociation: clip(pr.author_association, 40),
        url: clip(pr.html_url, 500),
        labels,
        base: { ref: baseRef, sha: clip(base.sha, 40) },
        head: { ref: headRef, sha: clip(head.sha, 40), repository: headRepo || null },
        fromFork: fork,
      },
    },
    fork ? null : headRef,
    { number, headSha: str(head.sha) },
  );
}

function release(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const rel = obj(p.release);
  const tag = clip(rel.tag_name, 255);
  const target = clip(rel.target_commitish, 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, target))) {
    return no(`release target ${target} not selected`);
  }
  // Creating or publishing a release needs write access: the tagged code is the repository's own.
  return finish(
    trigger,
    true,
    { event: 'release', action, tag, title: clip(rel.name, 300), branch: target, actor: sender },
    {
      event: 'release',
      action,
      repository: trigger.repository,
      sender,
      release: {
        tag,
        name: clip(rel.name, 300),
        body: clip(rel.body, 16_000),
        author: clip(obj(rel.author).login, 100),
        url: clip(rel.html_url, 500),
        draft: rel.draft === true,
        prerelease: rel.prerelease === true,
        target,
      },
    },
    tag === '' ? null : tag,
  );
}

function workflowRun(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const run = obj(p.workflow_run);
  const headRepo = str(obj(run.head_repository).full_name).toLowerCase();
  const fork = headRepo === '' || headRepo !== trigger.repository.toLowerCase();
  const cause = clip(run.event, 40);
  const headBranch = clip(run.head_branch, 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, headBranch))) {
    return no(`branch ${headBranch} not selected`);
  }
  const headSha = str(run.head_sha);
  const isTrusted = !fork && WRITE_CAUSES.has(cause);
  return finish(
    trigger,
    isTrusted,
    {
      event: 'workflow_run',
      action,
      title: clip(run.name, 300),
      branch: headBranch,
      sha: clip(headSha, 40),
      conclusion: clip(run.conclusion, 40),
      actor: sender,
      fork,
    },
    {
      event: 'workflow_run',
      action,
      repository: trigger.repository,
      sender,
      workflowRun: {
        name: clip(run.name, 300),
        cause,
        status: clip(run.status, 40),
        conclusion: clip(run.conclusion, 40),
        runNumber: num(run.run_number),
        headBranch,
        headSha: clip(headSha, 40),
        headRepository: headRepo || null,
        url: clip(run.html_url, 500),
        actor: clip(obj(run.actor).login, 100),
        pullRequests: arr(run.pull_requests)
          .map((x) => num(obj(x).number))
          .filter((n): n is number => n !== null)
          .slice(0, 20),
      },
    },
    SHA40.test(headSha) ? headSha : null,
  );
}

function checkSuite(trigger: GitHubTrigger, p: Json, action: string, sender: string): GitHubMatch {
  const suite = obj(p.check_suite);
  const headBranch = clip(suite.head_branch, 255);
  if (trigger.branches !== undefined && !trigger.branches.some((g) => globMatch(g, headBranch))) {
    return no(`branch ${headBranch} not selected`);
  }
  const prs = arr(suite.pull_requests).map(obj);
  // Conservative: a suite without a head branch (fork heads have none) or with a pull request whose head is
  // another repository is untrusted.
  const sameRepo = prs.every((pr) => {
    const h = obj(obj(pr.head).repo).id;
    const b = obj(obj(pr.base).repo).id;
    return h !== undefined && h === b;
  });
  const isTrusted = headBranch !== '' && sameRepo;
  const headSha = str(suite.head_sha);
  return finish(
    trigger,
    isTrusted,
    {
      event: 'check_suite',
      action,
      branch: headBranch,
      sha: clip(headSha, 40),
      conclusion: clip(suite.conclusion, 40),
      actor: sender,
    },
    {
      event: 'check_suite',
      action,
      repository: trigger.repository,
      sender,
      checkSuite: {
        status: clip(suite.status, 40),
        conclusion: clip(suite.conclusion, 40),
        headBranch,
        headSha: clip(headSha, 40),
        app: clip(obj(suite.app).slug, 100),
        headCommitMessage: clip(obj(suite.head_commit).message, 1000),
        pullRequests: prs
          .map((pr) => num(pr.number))
          .filter((n): n is number => n !== null)
          .slice(0, 20),
      },
    },
    SHA40.test(headSha) ? headSha : null,
  );
}
