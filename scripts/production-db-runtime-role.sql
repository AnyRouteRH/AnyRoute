-- Run as the migration/schema owner after migrations, with RUNTIME_DB_PASSWORD injected into psql.
-- API and workers get application DML only; they cannot create/alter schema objects or roles.
\getenv runtime_password RUNTIME_DB_PASSWORD
SELECT format('CREATE ROLE anyroute_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anyroute_runtime')
\gexec
ALTER ROLE anyroute_runtime PASSWORD :'runtime_password';
ALTER ROLE anyroute_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE anyroute TO anyroute_runtime;
GRANT USAGE ON SCHEMA public, drizzle TO anyroute_runtime;
REVOKE CREATE ON SCHEMA public, drizzle FROM PUBLIC, anyroute_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anyroute_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anyroute_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA drizzle FROM anyroute_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO anyroute_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anyroute IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anyroute_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anyroute IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anyroute_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anyroute IN SCHEMA drizzle
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anyroute_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anyroute IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO anyroute_runtime;
