import { aiStep, bearer, columns, defaults, edge, ex, node } from './build.js';
import type { WorkflowTemplate } from './types.js';

/**
 * Marketing templates:
 * - weekly content calendar → AI posts per channel → human approval → publish through a social API → report e-mail;
 * - lead intake webhook → enrichment API → score (code) → hot / nurture routing into a CRM, operators notified.
 * Hosts and credentials are placeholders the gallery wizard asks for.
 */

const RUNTIME = { key: 'runtime', kind: 'runtime', required: true, default: 'claude-code' } as const;

export const MARKETING_CONTENT_CALENDAR: WorkflowTemplate = {
  id: 'marketing-content-calendar',
  category: 'marketing',
  textKeys: ['approvalTitle', 'reportSubject', 'reportIntro', 'deniedTitle'],
  placeholders: [
    { key: 'brand', kind: 'text', required: true },
    { key: 'channels', kind: 'text', required: true, default: 'linkedin, x, instagram' },
    { key: 'language', kind: 'choice', required: true, default: 'tr', options: ['tr', 'en'] },
    { key: 'schedule_cron', kind: 'cron', required: true, default: '0 6 * * 1' },
    { key: 'social_origin', kind: 'origin', required: true },
    { key: 'social_path', kind: 'path', required: true, default: '/v1/posts' },
    {
      key: 'social_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'social_origin',
    },
    { key: 'smtp_provider', kind: 'smtpProvider', required: true, default: 'gmail' },
    { key: 'smtp_username', kind: 'text', required: true },
    {
      key: 'smtp_credential',
      kind: 'credential',
      required: true,
      credentialKind: 'smtp',
      hostFrom: 'smtp_provider',
    },
    { key: 'mail_from', kind: 'email', required: true },
    { key: 'report_to', kind: 'email', required: true },
    RUNTIME,
  ],
  build: (v, t) => ({
    schemaVersion: 2,
    name: t.name,
    description: t.description,
    inputs: {
      topic: {
        required: false,
        description: 'Focus topic of the week (optional; scheduled runs plan without one).',
      },
    },
    defaults: defaults(v),
    nodes: [
      node(t, 'weekly', 'trigger.schedule', { cron: v.schedule_cron, catchUp: 'once' }),
      node(t, 'manual', 'trigger.manual'),
      aiStep(
        t,
        'calendar',
        'executor',
        [
          `Plan next week's social media content calendar for the brand "${v.brand ?? ''}".`,
          `Channels: ${v.channels ?? ''}. Write every post in the language "${v.language ?? 'tr'}".`,
          'Focus topic for this week (may be empty — then choose timely, relevant themes yourself): {{inputs.topic}}',
          'Plan one post per channel for each weekday (Monday–Friday). Respect each channel’s length limits and tone',
          '(LinkedIn: professional, up to 1300 characters; X: up to 270 characters; Instagram: caption with up to 5',
          'hashtags). publishAt is an ISO 8601 instant in UTC within the coming week, at a good local posting time.',
          'Do not invent facts, prices, customers, statistics or links; keep claims general when unsure.',
          'Never include secrets or internal data. summary: two sentences about the week’s plan.',
        ].join('\n'),
        {
          outputSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string', maxLength: 1000 },
              posts: {
                type: 'array',
                maxItems: 40,
                items: {
                  type: 'object',
                  properties: {
                    channel: { type: 'string', maxLength: 40 },
                    text: { type: 'string', maxLength: 3000 },
                    publishAt: { type: 'string', maxLength: 40 },
                  },
                  required: ['channel', 'text', 'publishAt'],
                },
              },
            },
            required: ['posts'],
          },
        },
      ),
      node(t, 'review', 'control.approval', {
        approverRole: 'operator',
        title: `${t.text('approvalTitle')} ({{ $count($node.calendar.out.data.posts) }})`,
        details:
          '{{ $substring($join($node.calendar.out.data.posts.(channel & " · " & publishAt & "\\n" & text), "\\n\\n"), 0, 3900) }}',
        timeoutSec: 3 * 24 * 3600,
      }),
      node(t, 'publish', 'control.forEach', {
        items: ex('$node.calendar.out.data.posts'),
        concurrency: 2,
        onItemError: 'collect',
      }),
      node(
        t,
        'post',
        'http.request',
        {
          method: 'POST',
          origin: v.social_origin,
          path: v.social_path,
          headers: { 'Content-Type': 'application/json' },
          body: {
            type: 'json',
            value: ex('{"channel": $item.channel, "text": $item.text, "publishAt": $item.publishAt}'),
          },
          ...bearer(v.social_credential ?? ''),
          timeoutSec: 30,
        },
        { parent: 'publish' },
      ),
      node(
        t,
        'posted',
        'control.return',
        {
          value: ex(
            '{"channel": $item.channel, "publishAt": $item.publishAt, "status": $input.status, "id": $input.body.id}',
          ),
        },
        { parent: 'publish' },
      ),
      node(t, 'report', 'data.template', {
        template: `${t.text('reportIntro')}\n\n{{ $join($input.($exists(error) ? ("✗ " & error.code) : ("✓ " & channel & " · " & publishAt & " · " & $string(status))), "\\n") }}`,
      }),
      node(
        t,
        'mail',
        'email.send',
        {
          smtp: {
            provider: v.smtp_provider,
            username: v.smtp_username,
            credential: v.smtp_credential,
          },
          from: { address: v.mail_from },
          to: v.report_to,
          subject: t.text('reportSubject'),
          text: '{{ $input }}',
          maxRecipients: 5,
        },
        { onError: 'continue' },
      ),
      node(t, 'denied', 'notify.users', {
        recipients: { creator: true },
        title: t.text('deniedTitle'),
        body: '{{ $input.reason ? $input.reason : "-" }}',
        severity: 'info',
      }),
    ],
    edges: [
      edge('weekly', 'calendar'),
      edge('manual', 'calendar'),
      edge('calendar', 'review'),
      edge('review', 'publish', 'approved'),
      edge('review', 'denied', 'denied'),
      edge('publish', 'post', 'item'),
      edge('post', 'posted'),
      edge('publish', 'report', 'results'),
      edge('report', 'mail'),
    ],
    layout: columns([
      ['weekly', 'manual'],
      ['calendar'],
      ['review'],
      ['publish', 'denied'],
      ['post'],
      ['posted'],
      ['report'],
      ['mail'],
    ]),
  }),
};

const SCORE_JS = `// Lead score 0–100 from the webhook body and the enrichment response (absent when enrichment failed).
const lead = input.lead || {};
const enrichment = input.enrichment && input.enrichment.status ? input.enrichment.body || {} : {};
const reasons = [];
let score = 0;
const email = String(lead.email || '').toLowerCase();
const domain = email.split('@')[1] || '';
const free = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'yandex.com', 'proton.me'];
if (domain !== '' && !free.includes(domain)) { score += 20; reasons.push('business_email'); }
if (lead.company) { score += 10; reasons.push('company_given'); }
const size = Number(enrichment.employees || enrichment.companySize || 0);
if (size >= 200) { score += 30; reasons.push('company_200_plus'); }
else if (size >= 20) { score += 20; reasons.push('company_20_plus'); }
else if (size > 0) { score += 5; reasons.push('small_company'); }
const title = String(enrichment.title || enrichment.jobTitle || '').toLowerCase();
if (/(ceo|cto|cmo|founder|owner|head|director|vp|müdür|kurucu|sahibi)/.test(title)) { score += 25; reasons.push('decision_maker'); }
if (String(lead.message || '').length > 40) { score += 10; reasons.push('detailed_message'); }
if (lead.source === 'demo' || lead.source === 'pricing') { score += 15; reasons.push('high_intent_source'); }
return {
  score: Math.min(score, 100),
  reasons,
  enriched: Object.keys(enrichment).length > 0,
  email,
  name: lead.name || null,
  company: lead.company || enrichment.company || null,
  title: enrichment.title || enrichment.jobTitle || null,
};`;

const CRM_BODY = (status: 'hot' | 'nurture'): string =>
  `{"email": $node.score.out.email, "name": $node.score.out.name, "company": $node.score.out.company, "title": $node.score.out.title, "score": $node.score.out.score, "reasons": $node.score.out.reasons, "status": "${status}", "source": "remyral-workflow"}`;

export const MARKETING_LEAD_INTAKE: WorkflowTemplate = {
  id: 'marketing-lead-intake',
  category: 'marketing',
  textKeys: ['hotTitle', 'hotBody'],
  placeholders: [
    { key: 'enrich_origin', kind: 'origin', required: true },
    { key: 'enrich_path', kind: 'path', required: true, default: '/v1/person' },
    {
      key: 'enrich_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'enrich_origin',
    },
    { key: 'crm_origin', kind: 'origin', required: true },
    { key: 'crm_path', kind: 'path', required: true, default: '/v1/leads' },
    {
      key: 'crm_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'crm_origin',
    },
    { key: 'threshold', kind: 'number', required: true, default: '60', min: 1, max: 100 },
    RUNTIME,
  ],
  build: (v, t) => {
    const crm = (status: 'hot' | 'nurture'): Record<string, unknown> => ({
      method: 'POST',
      origin: v.crm_origin,
      path: v.crm_path,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'json', value: ex(CRM_BODY(status)) },
      ...bearer(v.crm_credential ?? ''),
      timeoutSec: 20,
    });
    return {
      schemaVersion: 2,
      name: t.name,
      description: t.description,
      inputs: {},
      defaults: defaults(v),
      nodes: [
        node(t, 'lead', 'trigger.webhook', {
          bodySchema: {
            type: 'object',
            properties: {
              email: { type: 'string', maxLength: 254 },
              name: { type: 'string', maxLength: 200 },
              company: { type: 'string', maxLength: 200 },
              message: { type: 'string', maxLength: 4000 },
              source: { type: 'string', maxLength: 64 },
            },
            required: ['email'],
          },
        }),
        node(
          t,
          'enrich',
          'http.request',
          {
            method: 'GET',
            origin: v.enrich_origin,
            path: v.enrich_path,
            query: { email: '{{ $trigger.body.email }}' },
            ...bearer(v.enrich_credential ?? ''),
            timeoutSec: 15,
          },
          { retry: { max: 2, backoff: 'exponential', initialSec: 5 } },
        ),
        node(t, 'enriched', 'control.merge', { join: 'any' }),
        node(t, 'score', 'code.js', {
          source: SCORE_JS,
          input: ex('{"lead": $trigger.body, "enrichment": $input.values[0]}'),
          timeoutSec: 10,
          memoryMb: 128,
        }),
        node(t, 'hot', 'control.if', { condition: `{{ $input.score >= ${String(Number(v.threshold))} }}` }),
        node(t, 'crm_hot', 'http.request', crm('hot')),
        node(t, 'alert', 'notify.users', {
          recipients: { role: 'operator' },
          title: `${t.text('hotTitle')}: {{ $node.score.out.email }}`,
          body: `${t.text('hotBody')} {{ $string($node.score.out.score) }}/100 · {{ $join($node.score.out.reasons, ", ") }}`,
          severity: 'warning',
        }),
        node(t, 'crm_nurture', 'http.request', crm('nurture')),
      ],
      edges: [
        edge('lead', 'enrich'),
        edge('enrich', 'enriched'),
        edge('enrich', 'enriched', 'error'),
        edge('enriched', 'score'),
        edge('score', 'hot'),
        edge('hot', 'crm_hot', 'true'),
        edge('crm_hot', 'alert'),
        edge('hot', 'crm_nurture', 'false'),
      ],
      layout: columns([
        ['lead'],
        ['enrich'],
        ['enriched'],
        ['score'],
        ['hot'],
        ['crm_hot', 'crm_nurture'],
        ['alert'],
      ]),
    };
  },
};
