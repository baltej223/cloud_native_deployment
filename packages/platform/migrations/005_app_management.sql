-- Phase 3: stop/start (by the user or after being idle) and rollback.

ALTER TABLE projects
  -- Why desired_state is 'stopped': the user stopped it, or it was idle.
  ADD COLUMN stop_reason TEXT CHECK (stop_reason IN ('user', 'idle')),
  -- Last network activity of the app (or when it was started), for auto-stop.
  ADD COLUMN last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- A rollback deployment reuses an earlier deployment's image instead of building.
ALTER TABLE deployments
  ADD COLUMN rollback_of UUID REFERENCES deployments (id) ON DELETE SET NULL;
