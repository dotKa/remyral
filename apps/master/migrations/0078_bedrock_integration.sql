-- p10-bedrock-integration-panel (docs/design/p10-semantic-memory.md §11): the Amazon Bedrock embedding credentials
-- are managed from Settings → Integrations like the Coolify / Cloudflare tokens. Additive. Migration number 0078
-- (0077 = p10-verify-health): renumber at merge if a parallel change took it.

-- One more provider row in the existing master-held integration table. The access key id + secret access key live
-- only in `secret` (AES-256-GCM under the HKDF sub-key `ops-integrations`, AAD `ops-integration:bedrock`); `config`
-- holds {region, model, keyIdHint} (the last four characters of the access key id, to recognise it in IAM).
ALTER TABLE ops_integrations DROP CONSTRAINT ops_integrations_provider_check;
ALTER TABLE ops_integrations ADD CONSTRAINT ops_integrations_provider_check
  CHECK (provider IN ('coolify', 'cloudflare', 'bedrock'));

-- The region the search index was last built with (Bedrock only; NULL for other providers and for rows written
-- before this migration). A region change is audited as a provider change and rebuilds the index, like a model
-- change; a NULL row with the same model adopts the region without a rebuild.
ALTER TABLE search_provider_state
  ADD COLUMN region text NULL CHECK (region IS NULL OR region ~ '^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$');
