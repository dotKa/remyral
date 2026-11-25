-- The console is English: the default workspace created by 0033 is shown as "General". Its id stays
-- `genel` (job, context and policy rows refer to projects by id). Only renamed if still at the default.
UPDATE projects SET name = 'General' WHERE id = 'genel' AND name = 'Genel';
