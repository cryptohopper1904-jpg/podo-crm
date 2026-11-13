-- Idempotent. Live-Patientensuche „Meinten Sie“: Vorfilter per Trigramm-Ähnlichkeit in der DB (pg_trgm, contrib,
-- in postgres:16(-alpine) enthalten; ab PG 13 „trusted“). Namen liegen ohnehin unverschlüsselt in patients
-- (B-Baum-Index patients_org_name) – der Index enthält nichts Neues. Ausdruck muss exakt zu src/server/patient-search.ts passen.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_name_trgm" ON "patients" USING gin ((lower("last_name" || ' ' || coalesce("first_name", ''))) gin_trgm_ops);
