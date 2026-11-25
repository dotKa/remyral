-- p1-backups: create or update the read-only backup role on an EXISTING database (volumes initialised
-- before the compose initdb hook knew about remyral_backup). Idempotent. Run as the superuser inside the
-- Postgres container, with the password in the environment (never on a command line). stack.env holds
-- REMYRAL_DB_BACKUP_PASSWORD (unquoted hex — docker's --env-file does not strip quotes):
--
--   sudo docker exec -i --env-file /data/remyral/prod/stack.env -u postgres <postgres container> \
--     psql -U postgres -d remyral -X -v ON_ERROR_STOP=1 -f - < infra/backup/sql/backup-role.sql
--
-- Without REMYRAL_DB_BACKUP_PASSWORD the role exists but stays NOLOGIN.
\getenv backup_pw REMYRAL_DB_BACKUP_PASSWORD
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'remyral_backup') AS create_role \gset
\if :create_role
CREATE ROLE remyral_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
\endif
-- Reads every table/sequence of every schema; no write privilege of any kind; owns nothing.
ALTER ROLE remyral_backup NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT pg_read_all_data TO remyral_backup WITH INHERIT TRUE;
SELECT current_database() AS dbname \gset
GRANT CONNECT ON DATABASE :"dbname" TO remyral_backup;
ALTER ROLE remyral_backup SET default_transaction_read_only = on;
-- p11-master-resilience (warm standby): the physical base backup uses the non-exclusive low-level API. These two
-- functions start/stop backup mode (a checkpoint and a WAL record); they grant no read or write of any data.
GRANT EXECUTE ON FUNCTION pg_backup_start(text, boolean), pg_backup_stop(boolean) TO remyral_backup;
\if :{?backup_pw}
SELECT :'backup_pw' <> '' AS set_password \gset
\if :set_password
ALTER ROLE remyral_backup LOGIN PASSWORD :'backup_pw';
\endif
\endif
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls,
       pg_has_role('remyral_backup', 'pg_read_all_data', 'USAGE') AS reads_all,
       has_function_privilege('remyral_backup', 'pg_backup_start(text, boolean)', 'EXECUTE') AS base_backup
  FROM pg_roles WHERE rolname = 'remyral_backup';
