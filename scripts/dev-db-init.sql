-- Runs once when the local dev Postgres (docker-compose.dev.yml) is first
-- created. The dev database itself (virtual_office) is made by the image; this
-- adds a separate one for the tests, so they never touch dev data.
-- Tables are created by the app's migrations (server/src/db/migrations.ts).
CREATE DATABASE virtual_office_test;
