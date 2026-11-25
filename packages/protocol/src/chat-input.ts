import { z } from 'zod';
import { NonNegativeInt, Sha256Hex } from './common.js';
import { CHAT_SITE_ZIP, CHAT_ZIP_PROBLEMS } from './site-files.js';

/**
 * Ops chat attachments and mentions (p8-chat-attachments-mentions, docs/design/p8-chat-attachments-mentions.md).
 *
 * The console uploads images (and small PDFs / text files) to the master, which scrubs and stores them per
 * thread. A turn names the attachments it carries (`AssistantTurnPayload.attachments`: id, type, size, SHA-256 —
 * covered by the turn signature) and the worker's assistant host pulls the bytes over its existing connection with
 * `ASSISTANT_ATTACHMENT_REQUEST` → `ASSISTANT_ATTACHMENT_DATA` (control messages, like JOB_INPUT_REQUEST /
 * JOB_INPUT_DATA), verifies size and digest, and hands them to the engine as model input. Mentions and text files
 * reach the model as fenced, size-bounded data in `AssistantTurnPayload.context` (never as instructions).
 *
 * Everything here is additive in protocol 1.0 and sent only to workers that advertise `assistant-input-v1`.
 */

export const ASSISTANT_INPUT_FEATURE = 'assistant-input-v1';

/** Raster images the chat accepts (checked by magic bytes on the master). */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ChatImageType = (typeof CHAT_IMAGE_TYPES)[number];

/** Per image / PDF (raw bytes; base64 for the model stays ≤ 5 MiB, the strictest provider limit). */
export const MAX_CHAT_BINARY_BYTES = 3_932_160;
/** Per text file (inlined as fenced data into the turn's context). */
export const MAX_CHAT_TEXT_BYTES = 256 * 1024;
/** Attachments per message. */
export const MAX_CHAT_ATTACHMENTS = 4;
/** Binary bytes of one message's attachments together. */
export const MAX_CHAT_MESSAGE_BYTES = 12 * 1024 * 1024;
/** Mentions per message. */
export const MAX_CHAT_MENTIONS = 8;
/** The fenced context block of one turn (mentions + text files). */
export const MAX_ASSISTANT_CONTEXT = 96 * 1024;
/** Raw bytes per ASSISTANT_ATTACHMENT_DATA answer (base64 stays far below MAX_FRAME_BYTES). */
export const ATTACHMENT_CHUNK_BYTES = 192 * 1024;

/**
 * p15-chat-zip: a .zip the console unpacked that is NOT a publishable site (no index.html at the root, too large, …).
 * Nothing of it is uploaded; the message only carries this note (the browser's own reading — data for the assistant,
 * which tells the user it cannot be published as a site). Sites travel as site upload ids instead.
 */
export const ChatArchiveNote = z.strictObject({
  /** The .zip's display name (no path). */
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\0/\\\r\n]+$/),
  fileCount: NonNegativeInt.max(100_000),
  totalBytes: NonNegativeInt.max(1024 * 1024 * 1024),
  problems: z.array(z.enum(CHAT_ZIP_PROBLEMS)).min(1).max(CHAT_ZIP_PROBLEMS.length),
});
export type ChatArchiveNote = z.infer<typeof ChatArchiveNote>;

/** p15-chat-zip: site uploads and archive notes of one message (together). */
export const MAX_CHAT_ZIPS = CHAT_SITE_ZIP.maxPerMessage;

/** What the model receives for an attachment: an image, or a PDF document (text files travel in `context`). */
export const AssistantAttachmentKind = z.enum(['image', 'pdf']);
export type AssistantAttachmentKind = z.infer<typeof AssistantAttachmentKind>;

/** One attachment a turn carries (signed with the turn; the worker verifies the bytes against it). */
export const AssistantAttachmentRef = z.strictObject({
  id: z.uuid(),
  kind: AssistantAttachmentKind,
  mediaType: z.enum([...CHAT_IMAGE_TYPES, 'application/pdf']),
  /** Display name (no path); never used as a file name on the worker. */
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\0/\\]+$/),
  sizeBytes: NonNegativeInt.max(MAX_CHAT_BINARY_BYTES),
  sha256: Sha256Hex,
});
export type AssistantAttachmentRef = z.infer<typeof AssistantAttachmentRef>;

/** `ASSISTANT_ATTACHMENT_REQUEST` payload (worker → master, control): one slice of a running turn's attachment. */
export const AssistantAttachmentRequestPayload = z.object({
  turnId: z.uuid(),
  requestId: z.uuid(),
  attachmentId: z.uuid(),
  offset: z.number().int().min(0).max(MAX_CHAT_BINARY_BYTES),
});
export type AssistantAttachmentRequestPayload = z.infer<typeof AssistantAttachmentRequestPayload>;

/**
 * `ASSISTANT_ATTACHMENT_DATA` payload (master → worker, control): the slice, only for an attachment of a turn the
 * master sent to that worker and that is still running. Never written to the master's durable outbox.
 */
export const AssistantAttachmentDataPayload = z.object({
  turnId: z.uuid(),
  requestId: z.uuid(),
  attachmentId: z.uuid(),
  status: z.enum(['ok', 'refused', 'not_found']),
  offset: z.number().int().min(0),
  data: z
    .string()
    .max(262_144)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
  eof: z.boolean(),
});
export type AssistantAttachmentDataPayload = z.infer<typeof AssistantAttachmentDataPayload>;

/**
 * How an engine takes attachments (CAPABILITIES.assistant.engines[].input, reported by `assistant-input-v1`
 * workers): `images` — `supported` (the runtime passes images to every model it runs), `model-dependent` (the
 * runtime passes them; the configured model may not read them) or `unsupported`; `pdf` — PDF documents as input.
 */
export const AssistantEngineInput = z.object({
  images: z.enum(['supported', 'model-dependent', 'unsupported']),
  pdf: z.boolean(),
});
export type AssistantEngineInput = z.infer<typeof AssistantEngineInput>;

/** True when the bytes start like the declared image / PDF type. */
export function attachmentMagicMatches(bytes: Uint8Array, mediaType: string): boolean {
  const starts = (sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);
  switch (mediaType) {
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/gif':
      return starts([0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    case 'application/pdf':
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      return false;
  }
}
