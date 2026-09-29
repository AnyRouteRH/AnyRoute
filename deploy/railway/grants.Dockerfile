# One-shot runtime database role and grants, run after `migrate` and before provider-init/api/worker.
# It connects with MIGRATION_DATABASE_URL (the role that ran migrations and owns the tables) and sets
# anyroute_runtime's password from RUNTIME_DB_PASSWORD. Both are Railway variables, never files here.
FROM postgres:16.15-bookworm@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67
COPY scripts/production-db-runtime-role.sql /opt/anyroute/production-db-runtime-role.sql
USER postgres
CMD ["sh", "-ec", ": \"${MIGRATION_DATABASE_URL:?Set MIGRATION_DATABASE_URL to the migration owner URL}\"; : \"${RUNTIME_DB_PASSWORD:?Set RUNTIME_DB_PASSWORD}\"; psql \"$MIGRATION_DATABASE_URL\" -X -q -v ON_ERROR_STOP=1 -f /opt/anyroute/production-db-runtime-role.sql; echo 'Runtime role grants completed successfully.'"]
