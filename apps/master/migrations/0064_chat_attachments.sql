-- p8-chat-attachments-mentions (docs/design/p8-chat-attachments-mentions.md): images, PDFs and small text files
-- attached to ops chat messages. Stored per thread (the thread's owner is the only reader, like the thread itself),
-- after the master's metadata scrub (EXIF/GPS, XMP, text chunks) and secret redaction / scan. `message_id` stays NULL
-- until the upload is sent with a message; unsent uploads are swept after 24 h. Deleting the thread deletes them.
-- Migration number 0064: renumber at merge if a parallel change took it.

CREATE TABLE chat_attachments (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id  uuid NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  media_type  text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 3932160),
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- What the scrub removed (exif, gps, xmp, iptc, comment, text-chunks, secrets:N).
  scrubbed    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scrubbed) <= 16),
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL,
  CHECK (octet_length(content) = size_bytes),
  CHECK (kind <> 'text' OR size_bytes <= 262144)
);
CREATE INDEX chat_attachments_thread_idx ON chat_attachments (thread_id, created_at);
CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX chat_attachments_unsent_idx ON chat_attachments (created_at) WHERE message_id IS NULL;
