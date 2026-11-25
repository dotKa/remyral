-- p6-warm-caches (docs/design/p6-warm-caches.md, ADR-0029): per-machine shared package caches. Additive only.
-- Migration number 0054: renumber at merge if a parallel change took it.

-- A project's opt-out. Default on: trusted host-profile jobs of the project share the machine's package cache for
-- the project (untrusted sources and container jobs never get one, whatever this says). Changed only through
-- PUT /projects/:id/package-caches (admin, step-up, audited `project.package_caches.update`).
ALTER TABLE projects
  ADD COLUMN package_caches boolean NOT NULL DEFAULT true,
  ADD COLUMN package_caches_updated_by text NULL CHECK (length(package_caches_updated_by) <= 128),
  ADD COLUMN package_caches_updated_at timestamptz NULL;

-- What each worker last reported in CAPABILITIES.packageCaches (limit, size per project and package manager, last
-- eviction): sizes and project ids only. Informational (machine page); NULL for workers that never reported it.
ALTER TABLE workers
  ADD COLUMN package_caches jsonb NULL CHECK (package_caches IS NULL OR jsonb_typeof(package_caches) = 'object'),
  ADD COLUMN package_caches_at timestamptz NULL;
