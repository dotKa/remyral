# Backup service image (p10-backup-restore; docs/design/p10-backup-restore.md §2, docs/ops/backup-restore.md).
#
#   docker build -f infra/backup/Dockerfile -t remyral-backup:<tag> .        # context: repository root
#
# Based on the exact Postgres image of the production server (infra/coolify/compose.yaml): pg_dump / pg_restore
# match the server, and the restore drill's throw-away server is the same build. Adds the Alpine packages
# `nodejs` (runner, no npm dependencies) and `age` (encryption to the owner's public keys) and GNU tar. Alpine
# keeps only the newest package revision in its index, so the packages are constrained to a major/minor
# (`~`) rather than an exact revision that would vanish; the deploy records the resulting image ID.
# The runner never needs a decryption key; none is ever put into this image or its mounts.
ARG PG_IMAGE=postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
FROM ${PG_IMAGE}

RUN apk add --no-cache 'nodejs~24' 'age~1.3' 'tar~1' \
 && node --version && age --version && tar --version | head -1 && pg_dump --version

COPY infra/backup/runner /opt/remyral-backup
# The release's migration files: the drill checks a restored schema against them (checksums as migrate.ts).
COPY apps/master/migrations /opt/remyral-backup/migrations

COPY --chmod=0755 <<'EOF' /usr/local/bin/remyral-backup
#!/bin/sh
set -eu
exec node /opt/remyral-backup/cli.mjs "$@"
EOF

ENV NODE_ENV=production \
    TZ=UTC \
    BACKUP_ROOT=/backups \
    BACKUP_SOURCE_DIR=/source \
    BACKUP_MIGRATIONS_DIR=/opt/remyral-backup/migrations
WORKDIR /opt/remyral-backup
# Healthy while the daemon heartbeats (written every minute; a one-shot `run`/`drill` container has no daemon).
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "const h=JSON.parse(require('fs').readFileSync('/backups/status/heartbeat.json','utf8'));process.exit(Date.now()-Date.parse(h.at)<300000?0:1)"]
ENTRYPOINT ["/usr/local/bin/remyral-backup"]
CMD ["daemon"]
