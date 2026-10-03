-- =============================================================================
-- Fix P1000 for user `society` — pgAdmin → PostgreSQL 17 → database "postgres"
-- Query Tool → paste all → Execute (F5). You must already be logged into pgAdmin.
-- =============================================================================

CREATE ROLE society WITH LOGIN PASSWORD 'society';

-- If error "role already exists", comment out CREATE ROLE above and run only:
-- ALTER ROLE society WITH LOGIN PASSWORD 'society';

CREATE DATABASE society OWNER society;

-- If error "database already exists", skip CREATE DATABASE and run:
-- ALTER DATABASE society OWNER TO society;

-- Then in server/.env use:
-- DATABASE_URL=postgresql://society:society@localhost:5432/society?schema=public
