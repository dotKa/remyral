-- p22-run-attention (docs/design/p22-run-attention.md; owner 2026-11-04: "sorunlu bir bitiş var… succeed olsada bir
-- field daha lazım bunu anlayıp ayırt edebilmemiz, asistanın otomatik olarak süreci ilerletmesi için"): a run can end
-- `succeeded` while a step could not do its work. Engine 2 writes, in the statement that ends the run, what needs a
-- look — a JSON array of {node, kind, note}:
--
--  * kind 'partial' / 'none'  an agent step said so (`OUTCOME:` line of its answer);
--  * kind 'input_cut'         an agent step got an upstream value cut to fit its prompt.
--
-- NULL: nothing to look at (also every run before this migration, engine 1 runs, failed / cancelled runs).
-- The result card, the run page, the watch note, the goal ledger (an assistant turn) and the API read it.
--
-- Additive. Rollback: an older master ignores the column; to remove: ALTER TABLE workflow_runs DROP COLUMN attention;

ALTER TABLE workflow_runs ADD COLUMN attention jsonb NULL
  CHECK (attention IS NULL OR jsonb_typeof(attention) = 'array');
