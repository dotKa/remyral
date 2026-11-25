-- p19-verifier-jobs (docs/design/p19-verifier-jobs.md): platform verifier jobs are platform jobs, not "failed jobs".
--
--  * report_only_jobs.checked_job_id: the job a platform report job checks (a job verification's verifier: the verified
--    job; the integration's verifier: the integration's root job; a post-deploy screenshot job: none). Written by the
--    master in the report job's creation transaction only. The console shows the verifier with a "Doğrulama" badge and
--    the checked job's verification outcome instead of a generic FAILED; plan items follow the checked job.
--  * job_verifications.error_cause: why a verification could not run (state `error`) as a short cause id
--    (`git_auth`, `git_network`, `timeout`, … — the self-heal failure classification of the verifier's failure, or
--    `not_started`). No new state: `error` already means "the verifier could not run" (Doğrulanamadı); the cause lets
--    the notification and the console say why in plain words. NULL: unknown / an older row.
--
-- Data: existing verifier jobs are linked to the job they checked and get a readable title ("Doğrula: <title>") where
-- their title was only derived from the verifier prompt ("You are a VERIFIER…"); a title a person edited is kept.
--
-- Additive. Rollback: an older master ignores both columns; to remove:
--   ALTER TABLE report_only_jobs DROP COLUMN checked_job_id; ALTER TABLE job_verifications DROP COLUMN error_cause;

ALTER TABLE report_only_jobs
  ADD COLUMN checked_job_id uuid NULL REFERENCES jobs (id) ON DELETE SET NULL;
CREATE INDEX report_only_jobs_checked ON report_only_jobs (checked_job_id) WHERE checked_job_id IS NOT NULL;

ALTER TABLE job_verifications
  ADD COLUMN error_cause text NULL CHECK (error_cause IS NULL OR error_cause ~ '^[a-z_]{1,32}$');

UPDATE report_only_jobs r SET checked_job_id = v.job_id
  FROM job_verifications v
 WHERE v.verifier_job_id = r.job_id AND r.purpose = 'verify' AND r.checked_job_id IS NULL;

UPDATE report_only_jobs r SET checked_job_id = i.root_job_id
  FROM integration_jobs ij JOIN integrations i ON i.id = ij.integration_id
 WHERE ij.job_id = r.job_id AND r.purpose = 'integration-verify' AND r.checked_job_id IS NULL
   AND i.root_job_id IS NOT NULL;

UPDATE job_titles t
   SET title = rtrim(left('Doğrula: ' || ct.title, 60))
  FROM report_only_jobs r JOIN job_titles ct ON ct.job_id = r.checked_job_id
 WHERE t.job_id = r.job_id AND r.purpose = 'verify' AND t.source = 'derived';

UPDATE job_titles t
   SET title = CASE r.purpose WHEN 'health' THEN 'Sağlık kontrolü' ELSE 'Entegrasyon doğrulaması' END
  FROM report_only_jobs r
 WHERE t.job_id = r.job_id AND r.purpose IN ('health', 'integration-verify') AND t.source = 'derived';
