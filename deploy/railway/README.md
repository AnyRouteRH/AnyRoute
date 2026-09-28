# Railway migration service

This image runs `bun scripts/migrate.ts` once and exits. It installs the locked production dependencies, uses the repository migration files, and does not start the API or workers. Configure the service's `DATABASE_URL` with a Railway private variable reference such as `${{Postgres.DATABASE_URL}}`; do not copy a database URL into source control.

Keep the service's source root at the repository root. In the service's **Settings → Config as Code** field, select `/deploy/railway/migrate.railway.json`. Railway does not resolve this config path relative to the source root. The config selects `deploy/railway/migrate.Dockerfile` relative to the repository root, so its `COPY` instructions can read `package.json`, `bun.lock`, `scripts/`, `src/db/`, and `drizzle/`.

The config sets the restart policy to `NEVER` with zero retries. After a migration deployment, check its exit status and logs for `Migrations completed successfully.` Do not use this service as a long-running process or attach a public domain. The configured policy is source configuration; confirm the effective policy in deployment details for the specific Railway service and deployment.

Railway documents custom config paths in its [Config as Code guide](https://docs.railway.com/config-as-code) and Dockerfile selection in its [Dockerfiles guide](https://docs.railway.com/builds/dockerfiles). Config as Code is deprecated for new services; use this file with a service that supports an existing Config as Code configuration, or translate the settings to Railway's current Infrastructure as Code format when creating a new service.
