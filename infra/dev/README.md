# Local development stack

Postgres and Redis for running `apps/master` (and later `apps/worker`) on a developer machine before
anything is deployed to EC2 (backlog task `p1-local-stack`). Production data services are configured
separately under `infra/coolify` (`p1-data-services`).

| Service  | Image                  | Host address      | Auth                              |
| -------- | ---------------------- | ----------------- | --------------------------------- |
| Postgres | `postgres:18.6-alpine` | `127.0.0.1:55432` | user/password from `.env` (SCRAM) |
| Redis    | `redis:8.10.2-alpine`  | `127.0.0.1:56379` | `requirepass` from `.env`         |

Both ports are published on the loopback interface only, never on `0.0.0.0`. Data lives in the named
volumes `remyral-dev_pgdata` and `remyral-dev_redisdata`. Non-default host ports avoid clashing with other
local Postgres/Redis instances; override them with `REMYRAL_PG_PORT` / `REMYRAL_REDIS_PORT` in `.env`.

## Usage

Prerequisites: Docker with Compose v2, Node 24, pnpm (Corepack).

```sh
pnpm dev:keygen   # once: writes .env (random dev passwords) and infra/dev/secrets/totp.key
pnpm dev:up       # start and wait until both healthchecks pass
pnpm --filter @remyral/master migrate
pnpm dev:down     # stop (volumes are kept)
```

`pnpm dev:keygen` is idempotent: it never overwrites an existing `.env` or key file and never prints
secret values. `.env` and everything in `infra/dev/secrets/` are git-ignored.

The master's integration tests (`pnpm test`) need this stack running; each test file creates and drops
its own throw-away database (`remyral_test_*`) and uses a unique Redis key prefix, so they never touch the
`remyral` development database.

## Resetting

Postgres and Redis initialise their credentials on the first start of an empty volume. If you regenerate
`.env`, delete the volumes so the new passwords take effect (this destroys local data):

```sh
docker compose --env-file .env -f infra/dev/compose.yaml down -v
```

## Security notes

- Dev-only credentials; never reuse them anywhere else.
- The Redis password is passed to `redis-server` on its command line inside the container (visible to
  `docker inspect`/`ps` on the host). Acceptable for a loopback-only dev stack, not for production.
- Production Redis is not published at all (threat model T-CP-6).
