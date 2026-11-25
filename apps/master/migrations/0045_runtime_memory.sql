-- p6-capacity-advice (docs/design/p6-capacity-advice.md): measured peak memory per job attempt (JOB_RESULT.resources)
-- and its rollup per worker × runtime, the input of the recommended parallel-jobs value.

-- One row per attempt (idempotent on a replayed JOB_RESULT). Pruned to the newest 50 per worker × runtime.
CREATE TABLE job_memory_samples (
  attempt_id        uuid PRIMARY KEY,
  job_id            uuid NOT NULL,
  worker_id         text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime           text NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  peak_bytes        bigint NOT NULL CHECK (peak_bytes >= 0),
  samples           integer NOT NULL CHECK (samples >= 1),
  recorded_at       timestamptz NOT NULL
);
CREATE INDEX job_memory_samples_worker_runtime_idx ON job_memory_samples (worker_id, runtime, recorded_at DESC);

-- Rollup, rewritten from the samples whenever one is added. `recent_peak_bytes` is the highest peak of the newest 20
-- attempts (what the recommendation uses: a recurring heavy job keeps it high, a one-off outlier ages out).
CREATE TABLE worker_runtime_memory (
  worker_id         text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime           text NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  attempts          integer NOT NULL CHECK (attempts >= 1),
  recent_peak_bytes bigint NOT NULL CHECK (recent_peak_bytes >= 0),
  max_peak_bytes    bigint NOT NULL CHECK (max_peak_bytes >= 0),
  last_peak_bytes   bigint NOT NULL CHECK (last_peak_bytes >= 0),
  updated_at        timestamptz NOT NULL,
  PRIMARY KEY (worker_id, runtime)
);
