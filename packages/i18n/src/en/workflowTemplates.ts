import type { Shape } from '../shape.js';
import type tr from '../tr/workflowTemplates.js';

/**
 * p14-workflow-engine 14.5 (ADR-0055): ready-made workflow templates — names, descriptions, node labels, the texts
 * written into the workflow (approval titles, notifications, report) and the wizard's placeholder labels.
 */
export default {
  categories: {
    marketing: 'Marketing',
    content: 'Content production',
    video: 'Video production',
  },
  items: {
    'marketing-content-calendar': {
      name: 'Weekly content calendar',
      description:
        'Every week it drafts posts per channel for your brand, puts them in front of an operator for approval and sends the approved posts, scheduled, to your social media API; at the end it e-mails a report. Needs the social media API address, an optional http-auth credential and an SMTP credential for the report.',
      nodes: {
        weekly: 'Every week',
        manual: 'Start manually',
        calendar: 'Write the calendar (AI)',
        review: 'Approve the calendar',
        publish: 'For each post',
        post: 'Send to the social API',
        posted: 'Post result',
        report: 'Prepare the report',
        mail: 'E-mail the report',
        denied: 'Rejection notice',
      },
      content: {
        approvalTitle: 'Weekly content calendar awaits approval',
        reportSubject: 'Weekly content calendar report',
        reportIntro: 'This week’s posts were sent to your social media API:',
        deniedTitle: 'Weekly content calendar rejected',
      },
      placeholders: {
        brand: { label: 'Brand', hint: 'The brand or product the posts are written for.' },
        channels: { label: 'Channels', hint: 'Comma-separated channels, e.g. linkedin, x, instagram.' },
        language: { label: 'Language', hint: 'Language of the posts (tr or en).' },
        schedule_cron: {
          label: 'Schedule (cron, UTC)',
          hint: 'When the calendar is written. Default: every Monday 06:00 UTC.',
        },
        social_origin: {
          label: 'Social media API address',
          hint: 'The service that schedules the posts (e.g. https://api.buffer.com). Public addresses only.',
        },
        social_path: { label: 'Post path', hint: 'The endpoint that creates a post, e.g. /v1/posts.' },
        social_credential: {
          label: 'Social media API credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        smtp_provider: { label: 'E-mail provider', hint: 'The SMTP provider that sends the report.' },
        smtp_username: { label: 'SMTP username', hint: 'Usually the sender’s e-mail address.' },
        smtp_credential: {
          label: 'SMTP credential',
          hint: 'An “smtp” password from the vault, bound to the provider’s server.',
        },
        mail_from: { label: 'Sender address', hint: 'The report’s sender address.' },
        report_to: { label: 'Report recipient', hint: 'Where the weekly report goes.' },
        runtime: {
          label: 'AI runtime',
          hint: 'The default runtime of the AI steps (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'marketing-lead-intake': {
      name: 'Lead intake',
      description:
        'Receives a web form submission through a signed webhook, adds company and title data from an enrichment API, scores it 0–100 in a code node and writes it to your CRM as “hot” or “nurture” by score; operators are notified about hot leads. The lead is recorded even when enrichment fails. Needs the enrichment and CRM API addresses.',
      nodes: {
        lead: 'Form webhook',
        enrich: 'Enrich the lead',
        enriched: 'Enrichment result',
        score: 'Score (code)',
        hot: 'Above the threshold?',
        crm_hot: 'Write to the CRM as hot',
        alert: 'Notify operators',
        crm_nurture: 'Write to the CRM as nurture',
      },
      content: {
        hotTitle: 'Hot lead',
        hotBody: 'Score:',
      },
      placeholders: {
        enrich_origin: {
          label: 'Enrichment API address',
          hint: 'A service returning person and company data for an e-mail address (e.g. https://person.clearbit.com).',
        },
        enrich_path: {
          label: 'Enrichment path',
          hint: 'The endpoint queried; the e-mail goes in the “email” parameter.',
        },
        enrich_credential: {
          label: 'Enrichment API credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        crm_origin: { label: 'CRM API address', hint: 'The CRM the leads are written to.' },
        crm_path: { label: 'CRM lead path', hint: 'The endpoint that creates a lead, e.g. /v1/leads.' },
        crm_credential: {
          label: 'CRM credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        threshold: {
          label: 'Hot threshold',
          hint: 'This score and above counts as hot (1–100, default 60).',
        },
        runtime: {
          label: 'AI runtime',
          hint: 'The default runtime of the AI steps (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'content-production': {
      name: 'Content production (research to publish)',
      description:
        'Researches a topic through a search API and has AI write a brief, an outline and the article; after an AI review an operator approves it. The approved text passes SEO checks in a code node and is sent to your content management system (CMS) over HTTP as a draft or published post. Needs the search and CMS API addresses.',
      nodes: {
        start: 'Start manually',
        research: 'Search the topic',
        brief: 'Research brief (AI)',
        outline: 'Outline (AI)',
        draft: 'Write the article (AI)',
        review: 'AI review',
        approve: 'Editor approval',
        seo: 'SEO checks (code)',
        seo_ok: 'SEO fine?',
        publish: 'Send to the CMS',
        published: 'Sent notice',
        seo_fix: 'SEO fixes notice',
        rejected: 'Rejection notice',
      },
      content: {
        approvalTitle: 'Article awaits approval',
        aiScore: 'AI review',
        publishedTitle: 'Article sent to the CMS',
        seoTitle: 'Article failed the SEO checks',
        rejectedTitle: 'Article rejected',
      },
      placeholders: {
        research_origin: {
          label: 'Search API address',
          hint: 'A search service returning results for the topic (e.g. https://api.search.brave.com).',
        },
        research_path: {
          label: 'Search path',
          hint: 'The endpoint queried; the search goes in the “q” parameter.',
        },
        research_credential: {
          label: 'Search API credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        cms_origin: { label: 'CMS API address', hint: 'The content management system the article goes to.' },
        cms_path: { label: 'CMS post path', hint: 'The endpoint that creates a post, e.g. /api/posts.' },
        cms_credential: {
          label: 'CMS credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        cms_status: { label: 'CMS status', hint: 'draft: saves a draft; publish: publishes right away.' },
        runtime: {
          label: 'AI runtime',
          hint: 'The default runtime of the AI steps (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'video-production': {
      name: 'Video production',
      description:
        'From a brief, AI writes a script and a shot list; each shot’s voice-over and image come from provider APIs, and the video is assembled with ffmpeg on a machine with containers. Once an operator approves the video it is uploaded to your video platform, published and you are told. Needs the voice-over, image and video platform API addresses and a machine with a container engine.',
      nodes: {
        start: 'Start manually',
        script: 'Script (AI)',
        storyboard: 'Shot list (AI)',
        shots: 'For each shot',
        voice: 'Request the voice-over',
        asset: 'Request the image',
        shot_ready: 'Shot ready',
        shot: 'Shot result',
        render: 'Assemble the video (ffmpeg)',
        review: 'Approve the video',
        create_upload: 'Create the upload',
        upload: 'Upload the video',
        publish: 'Publish the video',
        published: 'Published notice',
        rejected: 'Rejection notice',
      },
      content: {
        reviewTitle: 'Video awaits approval',
        publishedTitle: 'Video published',
        rejectedTitle: 'Video rejected',
      },
      placeholders: {
        tts_origin: {
          label: 'Voice-over API address',
          hint: 'A text-to-speech service; its answer must have a “url” field (e.g. https://api.elevenlabs.io).',
        },
        tts_path: { label: 'Voice-over path', hint: 'The endpoint that produces audio, e.g. /v1/speech.' },
        tts_credential: {
          label: 'Voice-over API credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        asset_origin: {
          label: 'Image API address',
          hint: 'A service producing a shot’s image or clip; its answer must have a “url” field.',
        },
        asset_path: { label: 'Image path', hint: 'The endpoint that produces an image, e.g. /v1/images.' },
        asset_credential: {
          label: 'Image API credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        video_origin: { label: 'Video platform API address', hint: 'The platform the video is uploaded to.' },
        video_upload_path: {
          label: 'Create-upload path',
          hint: 'The endpoint returning a pre-signed upload address (body.uploadUrl) and an id (body.id).',
        },
        video_publish_path: {
          label: 'Publish path',
          hint: 'The endpoint that publishes the uploaded video.',
        },
        video_credential: {
          label: 'Video platform credential',
          hint: 'Optional. An “http-auth” credential from the vault; added (Bearer) only when bound to this address.',
        },
        visibility: { label: 'Visibility', hint: 'private, unlisted or public.' },
        runtime: {
          label: 'AI runtime',
          hint: 'The default runtime of the AI steps (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
  },
} satisfies Shape<typeof tr>;
