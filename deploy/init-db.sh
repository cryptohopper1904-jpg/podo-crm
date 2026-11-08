#!/bin/sh
# Legt die App-Rolle an: KEIN Superuser, unterliegt Row-Level-Security.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE podo_app LOGIN PASSWORD '${PODO_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
