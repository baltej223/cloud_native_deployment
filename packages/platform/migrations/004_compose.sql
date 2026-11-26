-- Compose apps: a repository with a compose file at its root runs as several
-- containers. The project may name the service that gets the URL; each
-- deployment stores the services it runs, so a failed redeploy can start the
-- previous version again.

ALTER TABLE projects
  ADD COLUMN compose_service TEXT;

ALTER TABLE deployments
  ADD COLUMN compose JSONB;
