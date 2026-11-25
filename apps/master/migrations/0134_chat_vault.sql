-- p15-chat-vault (docs/design/p15-chat-vault.md): vault credentials from the Sohbet composer. Additive only.
--
--  * chat_drafts.kind + http_request (the assistant's run_http_request: one function job on a worker, the vault
--    credential by reference) and credential_save (propose_credential_save: a card the user's BROWSER completes — it
--    seals the value to the chosen machines' vault keys and creates the credential through /vault/credentials; the
--    master only marks the card done with the new credential's id). No value, ciphertext or token is stored here.
--
-- Rollback: the old master ignores the new kinds of existing rows (cards it cannot render stay generic); narrow the
-- constraint again by hand only after deleting such rows:
--   DELETE FROM chat_drafts WHERE kind IN ('http_request', 'credential_save');
-- Migration number 0134 (given in the brief); renumber at merge if needed.

CREATE FUNCTION pg_temp.widen_check_0134(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0134('chat_drafts', 'chat_drafts_kind_check', 'kind',
  ARRAY['http_request', 'credential_save']);
