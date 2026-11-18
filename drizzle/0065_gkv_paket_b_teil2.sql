-- GKV Paket B (Teil 2): Therapiebericht (Position 78530) und Folgeverordnung.
--
-- 1. therapy_reports – Therapiebericht je Verordnung (höchstens einer, eindeutiger Index) für die verordnende
--    Ärztin/den Arzt. Zählt mit dem Berichtsdatum als erbrachte Einheit 78530 im Preis-Snapshot. Änderbar, solange die
--    Verordnung nicht „abrechnungsreif“/„abgerechnet“ ist (dann auch kein neuer Bericht); Bezug (Verordnung, Person,
--    Praxis) unveränderlich; nie löschbar – außer mit der Person über podo_delete_patient (setzt podo.patient_delete).
-- 2. follow_up_requests – Vermerk „Folgeverordnung angefordert am“, append-only (gleiche Ausnahme beim Löschen der Person).
-- 3. patients.follow_up_expected – Dauerpatient:in: Hinweis „Folgeverordnung anfordern“ auch ohne geplante Termine.
-- Verweise nur innerhalb der Praxis (podo_fk_same_org, podo_user_in_org), RLS + FORCE, alle Funktionen mit festem
-- search_path. Idempotent: IF NOT EXISTS, Constraints nur wenn fehlend, CREATE OR REPLACE, DROP TRIGGER/POLICY IF EXISTS.
CREATE TABLE IF NOT EXISTS "therapy_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"report_date" date NOT NULL,
	"findings" text,
	"course" text,
	"result" text,
	"recommendation" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "follow_up_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "follow_up_expected" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_organization_id_organizations_id_fk') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_patient_id_patients_id_fk') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_created_by_users_id_fk') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_updated_by_users_id_fk') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_organization_id_organizations_id_fk') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_patient_id_patients_id_fk') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_created_by_users_id_fk') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  -- Freitexte begrenzt (Formular 4000 Zeichen je Feld), Vermerk 300 Zeichen
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'therapy_reports_values_check') THEN
    ALTER TABLE "therapy_reports" ADD CONSTRAINT "therapy_reports_values_check" CHECK (
      coalesce(char_length(findings), 0) <= 4000 AND coalesce(char_length(course), 0) <= 4000 AND coalesce(char_length(result), 0) <= 4000
      AND coalesce(char_length(recommendation), 0) <= 4000 AND coalesce(char_length(notes), 0) <= 4000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_values_check') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_values_check" CHECK (coalesce(char_length(note), 0) <= 300);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "therapy_reports_prescription" ON "therapy_reports" USING btree ("prescription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "therapy_reports_org_patient" ON "therapy_reports" USING btree ("organization_id","patient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follow_up_requests_org_prescription" ON "follow_up_requests" USING btree ("organization_id","prescription_id");
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['therapy_reports', 'follow_up_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Therapiebericht: Verordnung gehört zur Person; kein neuer/geänderter Bericht ab „abrechnungsreif“ (der Bericht ist
-- Teil des Preis-Snapshots); Bezug unveränderlich; Löschen nur mit der Person (podo_delete_patient)
CREATE OR REPLACE FUNCTION podo_therapy_report_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE vo_patient uuid; vo_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('podo.patient_delete', true), '') = OLD.patient_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Ein Therapiebericht kann nicht gelöscht werden.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.prescription_id IS DISTINCT FROM OLD.prescription_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'Bezug des Therapieberichts ist unveränderlich.' USING ERRCODE = 'P0001';
  END IF;
  SELECT p.patient_id, p.status INTO vo_patient, vo_status FROM prescriptions p
   WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id;
  IF vo_patient IS NULL OR vo_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Therapiebericht passt nicht zur Verordnung.' USING ERRCODE = 'P0001';
  END IF;
  IF vo_status IN ('billing_ready', 'billed') THEN
    RAISE EXCEPTION 'Die Verordnung ist abrechnungsreif bzw. abgerechnet – der Therapiebericht ist nicht mehr änderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_therapy_report_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS therapy_reports_guard ON therapy_reports;
--> statement-breakpoint
CREATE TRIGGER therapy_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON therapy_reports
  FOR EACH ROW EXECUTE FUNCTION podo_therapy_report_guard();
--> statement-breakpoint
-- Vermerk „Folgeverordnung angefordert“: nur anlegen; Löschen nur mit der Person (podo_delete_patient)
CREATE OR REPLACE FUNCTION podo_follow_up_request_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE vo_patient uuid;
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('podo.patient_delete', true), '') = OLD.patient_id::text THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Der Vermerk „Folgeverordnung angefordert“ ist unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  SELECT p.patient_id INTO vo_patient FROM prescriptions p WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id;
  IF vo_patient IS NULL OR vo_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Vermerk passt nicht zur Verordnung.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_follow_up_request_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS follow_up_requests_guard ON follow_up_requests;
--> statement-breakpoint
CREATE TRIGGER follow_up_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON follow_up_requests
  FOR EACH ROW EXECUTE FUNCTION podo_follow_up_request_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_no_truncate_gkv_documents() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Therapieberichte und Vermerke können nicht geleert werden.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_no_truncate_gkv_documents() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS therapy_reports_no_truncate ON therapy_reports;
--> statement-breakpoint
CREATE TRIGGER therapy_reports_no_truncate BEFORE TRUNCATE ON therapy_reports
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_documents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS follow_up_requests_no_truncate ON follow_up_requests;
--> statement-breakpoint
CREATE TRIGGER follow_up_requests_no_truncate BEFORE TRUNCATE ON follow_up_requests
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_documents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS therapy_reports_fk_same_org ON therapy_reports;
--> statement-breakpoint
CREATE TRIGGER therapy_reports_fk_same_org BEFORE INSERT OR UPDATE OF prescription_id, patient_id, organization_id ON therapy_reports
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('prescription_id', 'prescriptions', 'patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS follow_up_requests_fk_same_org ON follow_up_requests;
--> statement-breakpoint
CREATE TRIGGER follow_up_requests_fk_same_org BEFORE INSERT OR UPDATE OF prescription_id, patient_id, organization_id ON follow_up_requests
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('prescription_id', 'prescriptions', 'patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS therapy_reports_user_in_org ON therapy_reports;
--> statement-breakpoint
CREATE TRIGGER therapy_reports_user_in_org BEFORE INSERT OR UPDATE OF created_by, updated_by, organization_id ON therapy_reports
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor', 'updated_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS follow_up_requests_user_in_org ON follow_up_requests;
--> statement-breakpoint
CREATE TRIGGER follow_up_requests_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON follow_up_requests
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
COMMENT ON TABLE therapy_reports IS
  'Therapiebericht je Verordnung (Position 78530) für die verordnende Ärztin/den Arzt; Berichtsdatum = Tag der Einheit 78530 im Preis-Snapshot (Migration 0065).';
--> statement-breakpoint
COMMENT ON TABLE follow_up_requests IS
  'Vermerk „Folgeverordnung angefordert am“ je Verordnung, append-only (Migration 0065).';
