import { aiStep, bearer, columns, defaults, edge, ex, lit, node } from './build.js';
import type { WorkflowTemplate } from './types.js';

/**
 * Video production: brief → script (AI) → storyboard (AI, structured shots) → per shot a
 * voice-over (TTS provider) and an asset (image / clip provider) over HTTP → render with ffmpeg on a container worker
 * (AI executor step) → human review → create an upload at the video platform (pre-signed URL) → upload the file →
 * publish → notify. Designed for workspace projects: the rendered files pass on as out/ → in/.
 */

export const VIDEO_PRODUCTION: WorkflowTemplate = {
  id: 'video-production',
  category: 'video',
  textKeys: ['reviewTitle', 'publishedTitle', 'rejectedTitle'],
  placeholders: [
    { key: 'tts_origin', kind: 'origin', required: true },
    { key: 'tts_path', kind: 'path', required: true, default: '/v1/speech' },
    {
      key: 'tts_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'tts_origin',
    },
    { key: 'asset_origin', kind: 'origin', required: true },
    { key: 'asset_path', kind: 'path', required: true, default: '/v1/images' },
    {
      key: 'asset_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'asset_origin',
    },
    { key: 'video_origin', kind: 'origin', required: true },
    { key: 'video_upload_path', kind: 'path', required: true, default: '/v1/uploads' },
    { key: 'video_publish_path', kind: 'path', required: true, default: '/v1/videos' },
    {
      key: 'video_credential',
      kind: 'credential',
      required: false,
      credentialKind: 'http-auth',
      hostFrom: 'video_origin',
    },
    {
      key: 'visibility',
      kind: 'choice',
      required: true,
      default: 'private',
      options: ['private', 'unlisted', 'public'],
    },
    { key: 'runtime', kind: 'runtime', required: true, default: 'claude-code' },
  ],
  build: (v, t) => ({
    schemaVersion: 2,
    name: t.name,
    description: t.description,
    inputs: {
      brief: { required: true, description: 'What the video is about, for whom, and the call to action.' },
      duration_sec: { required: false, description: 'Target length in seconds (default 60).' },
      aspect: { required: false, description: 'Aspect ratio: 16:9, 9:16 or 1:1 (default 16:9).' },
      voice: {
        required: false,
        description: 'Voice id of the TTS provider (default: the provider’s default).',
      },
      language: { required: false, description: 'Language code of the voice-over (default tr).' },
    },
    defaults: defaults(v),
    nodes: [
      node(t, 'start', 'trigger.manual'),
      aiStep(
        t,
        'script',
        'executor',
        [
          'Write a video script from this brief: {{inputs.brief}}',
          'Target length: {{inputs.duration_sec}} seconds (default 60) · language: {{inputs.language}} (default tr).',
          'A hook in the first 3 seconds, one idea per scene, a clear call to action at the end; spoken text only in',
          'the voice-over lines. title ≤ 90 characters, description ≤ 500 characters for the video platform.',
        ].join('\n'),
        {
          outputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 100 },
              description: { type: 'string', maxLength: 1000 },
              script: { type: 'string', maxLength: 20000 },
            },
            required: ['title', 'description', 'script'],
          },
        },
      ),
      aiStep(
        t,
        'storyboard',
        'executor',
        [
          'Turn the script (fenced data) into a shot list / storyboard.',
          'Aspect ratio: {{inputs.aspect}} (default 16:9). Shots of 2–8 seconds whose durations add up to the target',
          'length; for each shot: n (1, 2, …), description (what is on screen), voiceover (the exact spoken line, may be',
          'empty), durationSec, and assetPrompt (a self-contained prompt for the image / clip generator; no brands,',
          'no real people, no text in the image).',
        ].join('\n'),
        {
          outputSchema: {
            type: 'object',
            properties: {
              shots: {
                type: 'array',
                maxItems: 30,
                items: {
                  type: 'object',
                  properties: {
                    n: { type: 'integer' },
                    description: { type: 'string', maxLength: 1000 },
                    voiceover: { type: 'string', maxLength: 1000 },
                    durationSec: { type: 'number' },
                    assetPrompt: { type: 'string', maxLength: 2000 },
                  },
                  required: ['n', 'description', 'voiceover', 'durationSec', 'assetPrompt'],
                },
              },
            },
            required: ['shots'],
          },
        },
      ),
      node(t, 'shots', 'control.forEach', {
        items: ex('$node.storyboard.out.data.shots'),
        concurrency: 2,
        onItemError: 'fail',
      }),
      node(
        t,
        'voice',
        'http.request',
        {
          method: 'POST',
          origin: v.tts_origin,
          path: v.tts_path,
          body: {
            type: 'json',
            value: ex(
              '{"text": $item.voiceover, "voice": $inputs.voice, "language": $inputs.language, "format": "mp3"}',
            ),
          },
          ...bearer(v.tts_credential ?? ''),
          timeoutSec: 120,
        },
        { parent: 'shots' },
      ),
      node(
        t,
        'asset',
        'http.request',
        {
          method: 'POST',
          origin: v.asset_origin,
          path: v.asset_path,
          body: {
            type: 'json',
            value: ex(
              '{"prompt": $item.assetPrompt, "aspectRatio": $inputs.aspect, "seconds": $item.durationSec}',
            ),
          },
          ...bearer(v.asset_credential ?? ''),
          timeoutSec: 120,
        },
        { parent: 'shots' },
      ),
      node(t, 'shot_ready', 'control.merge', { join: 'all', combine: 'object' }, { parent: 'shots' }),
      node(
        t,
        'shot',
        'control.return',
        {
          value: ex(
            '{"n": $item.n, "durationSec": $item.durationSec, "voiceover": $item.voiceover, "description": $item.description, "audioUrl": $node.voice.out.body.url, "assetUrl": $node.asset.out.body.url}',
          ),
        },
        { parent: 'shots' },
      ),
      aiStep(
        t,
        'render',
        'executor',
        [
          'Render the video with ffmpeg in this container from the shot list (fenced data: n, durationSec, audioUrl,',
          'assetUrl per shot). Aspect ratio {{inputs.aspect}} (default 16:9), 30 fps, H.264 + AAC.',
          '1. Download every audioUrl and assetUrl over HTTPS (curl --fail --location --max-filesize 200M) into a',
          '   work directory; stop with a clear error if a download fails.',
          '2. Build each shot: the still image (Ken Burns zoom) or clip, cut or padded to durationSec (or to the',
          '   voice-over length when longer), with its audio; then concatenate the shots in order of n.',
          '3. Write out/video.mp4, out/poster.jpg (a frame of shot 1) and out/shots.json (the shot list you used).',
          'Report the final duration, resolution and file size. Never upload anything and never print URLs with',
          'tokens in them.',
        ].join('\n'),
        { limits: { maxDurationSec: 5400 } },
      ),
      node(t, 'review', 'control.approval', {
        approverRole: 'operator',
        title: `${t.text('reviewTitle')}: {{ $substring($node.script.out.data.title, 0, 120) }}`,
        details: '{{ $substring($node.render.out.summary, 0, 3900) }}',
        timeoutSec: 7 * 24 * 3600,
      }),
      node(t, 'create_upload', 'http.request', {
        method: 'POST',
        origin: v.video_origin,
        path: v.video_upload_path,
        body: {
          type: 'json',
          value: ex(
            '{"title": $node.script.out.data.title, "description": $node.script.out.data.description, "fileName": "video.mp4", "contentType": "video/mp4"}',
          ),
        },
        ...bearer(v.video_credential ?? ''),
        timeoutSec: 30,
      }),
      aiStep(
        t,
        'upload',
        'executor',
        [
          'Upload the rendered video video.mp4 (handed to you from the render step under in/) to the video platform.',
          'The fenced data of the upload step holds the platform’s answer; its body.uploadUrl is a pre-signed upload',
          'URL (a short-lived capability — do not print, log or store it). Run exactly:',
          '  curl --fail --silent --show-error -X PUT -H "Content-Type: video/mp4" --upload-file <path of video.mp4> "$URL"',
          'with URL taken from the data. If body.uploadUrl is missing or the upload fails, stop with an error.',
          'Report only the HTTP status and the file size.',
        ].join('\n'),
        // Runs only with both the upload ticket and the render's files (a denied review skips the ticket).
        { join: { atLeast: 2 } },
      ),
      node(t, 'publish', 'http.request', {
        method: 'POST',
        origin: v.video_origin,
        path: v.video_publish_path,
        body: {
          type: 'json',
          value: ex(
            `{"uploadId": $node.create_upload.out.body.id, "title": $node.script.out.data.title, "description": $node.script.out.data.description, "visibility": ${lit(v.visibility ?? 'private')}}`,
          ),
        },
        ...bearer(v.video_credential ?? ''),
        timeoutSec: 30,
      }),
      node(t, 'published', 'notify.users', {
        recipients: { creator: true },
        title: `${t.text('publishedTitle')}: {{ $substring($node.script.out.data.title, 0, 120) }}`,
        body: '{{ $exists($input.body.url) ? $input.body.url : $string($input.status) }}',
      }),
      node(t, 'rejected', 'notify.users', {
        recipients: { creator: true },
        title: t.text('rejectedTitle'),
        body: '{{ $input.reason ? $input.reason : "-" }}',
      }),
    ],
    edges: [
      edge('start', 'script'),
      edge('script', 'storyboard'),
      edge('storyboard', 'shots'),
      edge('shots', 'voice', 'item'),
      edge('shots', 'asset', 'item'),
      edge('voice', 'shot_ready'),
      edge('asset', 'shot_ready'),
      edge('shot_ready', 'shot'),
      edge('shots', 'render', 'results'),
      edge('render', 'review'),
      edge('review', 'create_upload', 'approved'),
      edge('review', 'rejected', 'denied'),
      edge('create_upload', 'upload'),
      edge('render', 'upload'),
      edge('upload', 'publish'),
      edge('publish', 'published'),
    ],
    layout: columns([
      ['start'],
      ['script'],
      ['storyboard'],
      ['shots'],
      ['voice', 'asset'],
      ['shot_ready'],
      ['shot'],
      ['render'],
      ['review', 'rejected'],
      ['create_upload'],
      ['upload'],
      ['publish'],
      ['published'],
    ]),
  }),
};
