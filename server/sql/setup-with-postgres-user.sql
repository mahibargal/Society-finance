-- Use this if you prefer the postgres superuser (same password as pgAdmin login).
-- pgAdmin → database "postgres" → Query Tool:

CREATE DATABASE society;

-- Then set server/.env to (replace YOUR_PASSWORD):
-- DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/society?schema=public
