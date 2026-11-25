import { ASSISTANT_TOOLS, WATCH_CONDITIONS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { toolSummary } from '../../src/chat/tools.js';
import {
  guessLanguage,
  JOB_LABEL_TITLE_MAX,
  jobWatchLabel,
  mdText,
  shortJobTitle,
  splitLinks,
  WATCH_RULES,
  watchLink,
} from '../../src/chat/watches.js';
import { KIND_INFO, NOTIFICATION_KINDS } from '../../src/notifications/model.js';

/** p6-chat-notify: the pure parts of chat watches (rules, links, escaping, language) and the tool summaries. */
describe('chat watches (unit)', () => {
  it('allows only conditions from the fixed enum, per kind, with a default for each', () => {
    for (const [kind, rule] of Object.entries(WATCH_RULES)) {
      for (const c of rule.allowed) expect(WATCH_CONDITIONS).toContain(c);
      for (const c of rule.defaults) expect(rule.allowed).toContain(c);
      if (kind !== 'worker' && kind !== 'monitor') expect(rule.defaults.length).toBeGreaterThan(0);
    }
    expect(WATCH_RULES.job.allowed).toContain('approval_requested');
    expect(WATCH_RULES.worker.allowed).toEqual(['online', 'offline']);
    // "every time" only where something repeats.
    expect(
      Object.entries(WATCH_RULES)
        .filter(([, r]) => r.every)
        .map(([k]) => k),
    ).toEqual(['automation', 'worker', 'monitor']);
    // p8-uptime: monitors go down / up again (default: the opposite of the current state, like machines).
    expect(WATCH_RULES.monitor).toMatchObject({
      allowed: ['down', 'up'],
      defaults: [],
      action: 'uptime.read',
    });
  });

  it('links to console pages only', () => {
    const id = '0b0bd1f0-efc0-479e-84de-4c60f201d86c';
    expect(watchLink('job', id, null)).toBe(`/jobs/${id}`);
    expect(watchLink('workflow_run', id, null)).toBe(`/jobs/workflows/${id}`);
    expect(watchLink('automation', id, null)).toBe(`/automations/${id}?tab=runs`);
    expect(watchLink('ops_action', id, null)).toBe(`/deploys/${id}`);
    expect(watchLink('monitor', id, null)).toBe(`/uptime/${id}`);
    expect(watchLink('approval', id, null)).toBe(`/approvals/${id}`);
    expect(watchLink('worker', 'wrk_cccccccccccccccccccccccccc', null)).toBe(
      '/machines/wrk_cccccccccccccccccccccccccc',
    );
    expect(watchLink('draft', id, id)).toBe(`/chat/${id}`);
  });

  it('renders labels literally in Markdown (no injected links, images or HTML)', () => {
    const evil =
      'Fix [click me](https://evil.example) ![x](https://evil.example/p.png) <img src=x> `code`\nnext';
    const out = mdText(evil);
    expect(out).not.toMatch(/(^|[^\\])\[/);
    expect(out).not.toMatch(/(^|[^\\])</);
    expect(out).not.toContain('\n');
    expect(out).toContain('\\[click me\\]\\(https://evil.example\\)');
  });

  it('moves console links out of the Markdown and keeps absolute ones', () => {
    expect(
      splitLinks(
        '**Job succeeded:** Build. [Open](/jobs/1) · [Outputs](/outputs?job=1) · Live: [https://a.dev](https://a.dev)',
      ),
    ).toEqual({
      text: '**Job succeeded:** Build. · Live: [https://a.dev](https://a.dev)',
      links: [
        { label: 'Open', href: '/jobs/1' },
        { label: 'Outputs', href: '/outputs?job=1' },
      ],
    });
    // Protocol-relative is not a console link.
    expect(splitLinks('x [a](//evil.example)').links).toEqual([]);
  });

  it('guesses the thread language from the user’s messages', () => {
    expect(guessLanguage(['iş bitince haber ver'])).toBe('tr');
    expect(guessLanguage(['deploy olunca bana söyle'])).toBe('tr');
    expect(guessLanguage(['let me know when the job is done'])).toBe('en');
    expect(guessLanguage([])).toBe('en');
  });

  it('registers the notification kinds with labels', () => {
    expect(NOTIFICATION_KINDS).toContain('chat.watch');
    expect(NOTIFICATION_KINDS).toContain('chat.note');
    expect(KIND_INFO['chat.watch'].label).toMatch(/watch/i);
    expect(KIND_INFO['chat.note'].label).toMatch(/note/i);
  });

  it('summarises notify tool calls for the transcript without content', () => {
    expect(ASSISTANT_TOOLS.notify_when.kind).toBe('notify');
    expect(
      toolSummary('notify_when', { ok: true, data: { watching: 'Job 0b0bd1f0: Build', watchId: 'x' } }),
    ).toBe('notify_when: watching “Job 0b0bd1f0: Build”');
    expect(toolSummary('cancel_watch', { ok: true, data: { cancelled: [{}, {}] } })).toBe(
      'cancel_watch: 2 cancelled',
    );
    expect(toolSummary('notify_me', { ok: true, data: { sent: 'to you only' } })).toBe(
      'notify_me: note sent to you',
    );
    expect(toolSummary('notify_me', { ok: false, code: 'invalid', message: 'At most 10 notes' })).toContain(
      'failed',
    );
  });
});

/** p15-merge-approvals item 3, p15-job-titles: job watch labels ("İş 0a1b2c3d · <title>"). */
describe('job watch labels', () => {
  const ID = '0a1b2c3d-1111-4222-8333-444455556666';
  const PROMPT =
    'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı yeniden yapılandır ve dağıt.';

  it('uses the title derived from the prompt (≤ 60 characters) in the watch language', () => {
    const title = shortJobTitle(null, PROMPT);
    expect(title.length).toBeLessThanOrEqual(JOB_LABEL_TITLE_MAX);
    expect(title).toBe('Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY…');
    expect(jobWatchLabel(ID, title, 'tr')).toBe(`İş 0a1b2c3d · ${title}`);
    expect(jobWatchLabel(ID, title, 'en')).toBe(`Job 0a1b2c3d · ${title}`);
  });

  it("prefers the job's own title, skips blank lines and drops an empty title", () => {
    expect(shortJobTitle('SampleWebApp: Coolify deploy dalı hazırla', PROMPT)).toBe(
      'SampleWebApp: Coolify deploy dalı hazırla',
    );
    expect(shortJobTitle(null, '\n\n  fix   the bug  \nmore')).toBe('fix the bug');
    expect(shortJobTitle('x'.repeat(80), null)).toHaveLength(JOB_LABEL_TITLE_MAX);
    expect(jobWatchLabel(ID, shortJobTitle(null, ''), 'tr')).toBe('İş 0a1b2c3d');
  });
});
