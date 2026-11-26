-- Projects are the apps users deploy; deployments are attempts to run a
-- version of a project. The database holds the desired state, and the
-- deployment controller makes the infrastructure match it.

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{1,28}[a-z0-9]$'),
  source_type TEXT NOT NULL CHECK (source_type IN ('image', 'repo')),
  image TEXT,
  container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  health_check_path TEXT NOT NULL DEFAULT '/',
  env JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Host port (locally) or load balancer port (on AWS) that serves the app.
  assigned_port INTEGER NOT NULL UNIQUE CHECK (assigned_port BETWEEN 1 AND 65535),
  desired_state TEXT NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped')),
  -- Set when the user deletes the project; the controller removes the app,
  -- then the row (which frees the name and port).
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_type <> 'image' OR image IS NOT NULL)
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'building', 'deploying', 'live', 'failed', 'superseded', 'cancelled')),
  image_ref TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX deployments_project_created_idx ON deployments (project_id, created_at DESC);

-- At most one deployment in progress per project.
CREATE UNIQUE INDEX deployments_one_active_per_project
  ON deployments (project_id) WHERE status IN ('pending', 'building', 'deploying');

-- At most one live deployment per project.
CREATE UNIQUE INDEX deployments_one_live_per_project
  ON deployments (project_id) WHERE status = 'live';

-- Reject status changes the lifecycle does not allow (mirrors
-- DEPLOYMENT_TRANSITIONS in packages/contracts) and keep timestamps right.
CREATE FUNCTION deployments_check_transition() RETURNS trigger AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending' THEN ARRAY['building', 'deploying', 'failed', 'cancelled']
    WHEN 'building' THEN ARRAY['deploying', 'failed', 'cancelled']
    WHEN 'deploying' THEN ARRAY['live', 'failed', 'cancelled']
    WHEN 'live' THEN ARRAY['superseded']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid deployment transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  IF OLD.status = 'pending' AND NEW.started_at IS NULL THEN
    NEW.started_at := now();
  END IF;
  IF NEW.status IN ('live', 'failed', 'cancelled') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_transition
  BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION deployments_check_transition();
