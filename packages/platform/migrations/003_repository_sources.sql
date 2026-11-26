-- Repository sources: the platform clones a GitHub repository, finds its
-- Dockerfile and builds it. The container port becomes optional for them,
-- because it can be read from the Dockerfile's EXPOSE instruction.

ALTER TABLE projects
  ADD COLUMN repo_url TEXT,
  ADD COLUMN branch TEXT,
  ADD COLUMN dockerfile_path TEXT,
  ALTER COLUMN container_port DROP NOT NULL,
  ADD CONSTRAINT projects_repo_source_has_url CHECK (source_type <> 'repo' OR repo_url IS NOT NULL),
  ADD CONSTRAINT projects_image_source_has_port CHECK (source_type <> 'image' OR container_port IS NOT NULL);

-- What each deployment actually used, as discovered during the build.
ALTER TABLE deployments
  ADD COLUMN commit_sha TEXT,
  ADD COLUMN dockerfile_path TEXT,
  ADD COLUMN context_path TEXT,
  ADD COLUMN container_port INTEGER CHECK (container_port BETWEEN 1 AND 65535),
  ADD COLUMN build_log TEXT NOT NULL DEFAULT '',
  -- When the deployment entered "deploying": deploy timeouts exclude build time.
  ADD COLUMN deploy_started_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION deployments_check_transition() RETURNS trigger AS $$
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
  IF NEW.status = 'deploying' AND NEW.deploy_started_at IS NULL THEN
    NEW.deploy_started_at := now();
  END IF;
  IF NEW.status IN ('live', 'failed', 'cancelled') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
