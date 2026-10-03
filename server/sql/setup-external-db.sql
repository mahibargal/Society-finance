-- =============================================================================
-- pgAdmin: connect to server "PostgreSQL 17", open Query Tool on database POSTGRES
-- Run PART 1 below, then refresh Databases in the tree — "society" should appear.
-- Then select database "society" in the dropdown and run PART 2 in a new Query Tool.
-- =============================================================================

-- PART 1 — run while connected to database "postgres"
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'society') THEN
    CREATE ROLE society WITH LOGIN PASSWORD 'society';
  END IF;
END
$$;

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'society' AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS society;
CREATE DATABASE society OWNER society;

-- PART 2 — run while connected to database "society" (change dropdown at top of Query Tool)
GRANT ALL ON SCHEMA public TO society;
ALTER SCHEMA public OWNER TO society;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO society;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO society;
