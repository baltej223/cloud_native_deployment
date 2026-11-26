-- Hosted Postgres such as Supabase exposes tables in the public schema through
-- an auto-generated REST API, reachable with the project's public anon key.
-- Enabling row-level security with no policies denies those API roles all
-- access. The platform connects as the table owner, which RLS does not
-- restrict. On plain Postgres (local Docker, RDS) it is harmless.

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
