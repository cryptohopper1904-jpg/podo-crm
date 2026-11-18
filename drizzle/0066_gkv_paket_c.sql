-- GKV Paket C: Kennzeichen Verordnungsart, Verordnungsbesonderheiten, Genehmigung (SKZ B2), Absetzungen/Retaxen und
-- Korrektur abgerechneter Verordnungen.
--
-- 1. prescriptions: prescription_kind ('03' | '04', Anlage 3 zu § 302 V21 8.1.12) mit Bestätigung (wer/wann),
--    prescription_special (8.1.11), approval_ref/approval_date (Genehmigung langfristiger Heilmittelbedarf, SKZ, Art B2,
--    8.1.17). Bestand bleibt NULL = nicht bestätigt (keine Abrechnungsreife, kein § 302-Export – nie „03“ raten).
--    ADD COLUMN/ADD CONSTRAINT lösen keine Zeilen-Trigger aus: abgerechnete Zeilen (prescriptions_billed_lock) bleiben
--    unberührt.
-- 2. gkv_deductions: Absetzung/Retaxe der Kasse zu einer abgerechneten Verordnung (Betrag, Grund/Code, Datum, Status
--    offen/akzeptiert/Widerspruch/erledigt, Notiz). Betrag/Grund/Datum nur „offen“ änderbar, Bezug unveränderlich,
--    nie löschbar (außer mit der Person: podo_owner_delete_allowed wie 0019/0065 – podo_delete_patient verweigert das
--    aber, solange eine Absetzung existiert).
-- 3. prescription_corrections: nachvollziehbare Korrektur einer abgerechneten Verordnung. Hält den Stand der
--    Erstabrechnung fest (Lauf, Zeitpunkt, Beträge, Preis-Snapshot) und ist Voraussetzung für den einzigen erlaubten
--    Wechsel aus „abgerechnet“: → „Korrektur nötig“ (correction_needed). Erledigt durch erneute Abrechnung (rebilled)
--    oder ohne Neuabrechnung (no_rebill); danach unveränderlich.
-- 4. billing_batches_org_id: eindeutiger Index (organization_id, id) für den Lookup in podo_fk_same_org.
-- Verweise nur innerhalb der Praxis (podo_fk_same_org, podo_user_in_org), RLS + FORCE, alle Funktionen mit festem
-- search_path. Idempotent: IF NOT EXISTS, Constraints nur wenn fehlend, CREATE OR REPLACE, DROP TRIGGER/POLICY IF EXISTS.
CREATE TABLE IF NOT EXISTS "gkv_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"billing_batch_id" uuid,
	"amount_cents" integer NOT NULL,
	"reason_code" text,
	"reason" text NOT NULL,
	"deducted_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prescription_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"deduction_id" uuid,
	"reason" text NOT NULL,
	"original_batch_id" uuid,
	"original_billed_at" timestamp with time zone,
	"original_remedy_cost_cents" integer,
	"original_copayment_cents" integer,
	"original_price_snapshot" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolved_batch_id" uuid,
	"resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "prescription_kind" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "prescription_kind_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "prescription_kind_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "prescription_special" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "approval_ref" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "approval_date" date;--> statement-breakpoint
-- Hinweis zu ON DELETE cascade (Praxis, Verordnung, Person): nur formal – die Guards unten verbieten das Löschen außer im
-- Löschlauf der Person (podo_delete_patient, verweigert bei Absetzungen/Korrekturen) bzw. der ganzen Praxis (Eigentümer,
-- Trigger abgeschaltet).
-- Namen über 63 Zeichen kürzt PostgreSQL – die Prüfung vergleicht deshalb mit left(…, 63).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_organization_id_organizations_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_patient_id_patients_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_billing_batch_id_billing_batches_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_billing_batch_id_billing_batches_id_fk" FOREIGN KEY ("billing_batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_created_by_users_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_updated_by_users_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_organization_id_organizations_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_patient_id_patients_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_deduction_id_gkv_deductions_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_deduction_id_gkv_deductions_id_fk" FOREIGN KEY ("deduction_id") REFERENCES "public"."gkv_deductions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = left('prescription_corrections_original_batch_id_billing_batches_id_fk', 63)) THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_original_batch_id_billing_batches_id_fk" FOREIGN KEY ("original_batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_created_by_users_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_resolved_by_users_id_fk') THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = left('prescription_corrections_resolved_batch_id_billing_batches_id_fk', 63)) THEN
    ALTER TABLE "prescription_corrections" ADD CONSTRAINT "prescription_corrections_resolved_batch_id_billing_batches_id_fk" FOREIGN KEY ("resolved_batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_prescription_kind_confirmed_by_users_id_fk') THEN
    ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_prescription_kind_confirmed_by_users_id_fk" FOREIGN KEY ("prescription_kind_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  -- Kennzeichen Verordnungsart: nur 03/04 (05 Blankoverordnung nicht für Podologie); gesetzt ⇔ bestätigt
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_prescription_kind_check') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_prescription_kind_check CHECK (
      (prescription_kind IS NULL OR prescription_kind IN ('03', '04'))
      AND (prescription_kind IS NULL) = (prescription_kind_confirmed_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_special_approval_check') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_special_approval_check CHECK (
      (prescription_special IS NULL OR prescription_special IN ('1', '2', '4', '7', '9'))
      AND (approval_ref IS NULL) = (approval_date IS NULL)
      AND (approval_ref IS NULL OR char_length(approval_ref) BETWEEN 1 AND 20));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_values_check') THEN
    ALTER TABLE gkv_deductions ADD CONSTRAINT gkv_deductions_values_check CHECK (
      status IN ('open', 'accepted', 'objected', 'done')
      AND amount_cents > 0 AND amount_cents <= 1000000
      AND char_length(reason) BETWEEN 3 AND 500
      AND coalesce(char_length(reason_code), 0) <= 20
      AND coalesce(char_length(note), 0) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_corrections_values_check') THEN
    ALTER TABLE prescription_corrections ADD CONSTRAINT prescription_corrections_values_check CHECK (
      char_length(reason) BETWEEN 5 AND 500
      AND coalesce(char_length(resolution_note), 0) <= 500
      AND (resolution IS NULL OR resolution IN ('rebilled', 'no_rebill'))
      AND (resolution IS NULL) = (resolved_at IS NULL)
      AND (resolution IS DISTINCT FROM 'rebilled' OR resolved_batch_id IS NOT NULL));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gkv_deductions_org_id" ON "gkv_deductions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gkv_deductions_org_status" ON "gkv_deductions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gkv_deductions_org_prescription" ON "gkv_deductions" USING btree ("organization_id","prescription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescription_corrections_org_prescription" ON "prescription_corrections" USING btree ("organization_id","prescription_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prescription_corrections_open" ON "prescription_corrections" USING btree ("prescription_id") WHERE "prescription_corrections"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_batches_org_id" ON "billing_batches" USING btree ("organization_id","id");--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gkv_deductions', 'prescription_corrections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Absetzung: nur zu einer abgerechneten Verordnung derselben Person; Bezug unveränderlich; Betrag/Grund/Code/Datum nur
-- solange „offen“; „erledigt“ ist abschließend; Löschen nur mit der Person (podo_owner_delete_allowed, Muster 0019/0065)
CREATE OR REPLACE FUNCTION podo_gkv_deduction_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE vo_patient uuid; vo_status text; vo_billed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Eine Absetzung kann nicht gelöscht werden (Aufbewahrung) – bitte den Status ändern.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prescription_id IS DISTINCT FROM OLD.prescription_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.billing_batch_id IS DISTINCT FROM OLD.billing_batch_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Bezug der Absetzung ist unveränderlich.' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'open' AND (NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.deducted_on IS DISTINCT FROM OLD.deducted_on) THEN
      RAISE EXCEPTION 'Betrag, Grund und Datum sind nur bei offenen Absetzungen änderbar.' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'done' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Die Absetzung ist erledigt und damit abgeschlossen.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.patient_id, p.status, p.billed_at INTO vo_patient, vo_status, vo_billed FROM prescriptions p
   WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id;
  IF vo_patient IS NULL OR vo_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Absetzung passt nicht zur Verordnung.' USING ERRCODE = 'P0001';
  END IF;
  IF vo_billed IS NULL AND vo_status NOT IN ('billed', 'correction_needed') THEN
    RAISE EXCEPTION 'Absetzungen gibt es nur zu abgerechneten Verordnungen.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_gkv_deduction_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gkv_deductions_guard ON gkv_deductions;
--> statement-breakpoint
CREATE TRIGGER gkv_deductions_guard BEFORE INSERT OR UPDATE OR DELETE ON gkv_deductions
  FOR EACH ROW EXECUTE FUNCTION podo_gkv_deduction_guard();
--> statement-breakpoint
-- Korrekturvermerk: nur zu einer abgerechneten Verordnung derselben Person (Absetzung, falls angegeben, zur selben
-- Verordnung); einzige Änderung ist das Abschließen (resolution/resolved_*), danach unveränderlich; Löschen nur mit der
-- Person (podo_owner_delete_allowed)
CREATE OR REPLACE FUNCTION podo_prescription_correction_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  vo_patient uuid;
  vo_status text;
  ded_vo uuid;
  resolve_cols text[] := ARRAY['resolution', 'resolved_at', 'resolved_by', 'resolved_batch_id', 'resolution_note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Ein Korrekturvermerk kann nicht gelöscht werden (Nachvollziehbarkeit).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'Die Korrektur ist abgeschlossen und unveränderlich.' USING ERRCODE = 'P0001';
    END IF;
    IF (to_jsonb(NEW) - resolve_cols) IS DISTINCT FROM (to_jsonb(OLD) - resolve_cols) OR NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION 'Ein Korrekturvermerk kann nur abgeschlossen, nicht geändert werden.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.patient_id, p.status INTO vo_patient, vo_status FROM prescriptions p
   WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id;
  IF vo_patient IS NULL OR vo_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Korrekturvermerk passt nicht zur Verordnung.' USING ERRCODE = 'P0001';
  END IF;
  IF vo_status <> 'billed' THEN
    RAISE EXCEPTION 'Eine Korrektur gibt es nur für abgerechnete Verordnungen.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ein neuer Korrekturvermerk ist noch offen.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.deduction_id IS NOT NULL THEN
    SELECT d.prescription_id INTO ded_vo FROM gkv_deductions d WHERE d.id = NEW.deduction_id AND d.organization_id = NEW.organization_id;
    IF ded_vo IS DISTINCT FROM NEW.prescription_id THEN
      RAISE EXCEPTION 'Die Absetzung gehört zu einer anderen Verordnung.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_correction_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescription_corrections_guard ON prescription_corrections;
--> statement-breakpoint
CREATE TRIGGER prescription_corrections_guard BEFORE INSERT OR UPDATE OR DELETE ON prescription_corrections
  FOR EACH ROW EXECUTE FUNCTION podo_prescription_correction_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_no_truncate_gkv_billing() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Absetzungen und Korrekturvermerke können nicht geleert werden.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_no_truncate_gkv_billing() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gkv_deductions_no_truncate ON gkv_deductions;
--> statement-breakpoint
CREATE TRIGGER gkv_deductions_no_truncate BEFORE TRUNCATE ON gkv_deductions
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_billing();
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescription_corrections_no_truncate ON prescription_corrections;
--> statement-breakpoint
CREATE TRIGGER prescription_corrections_no_truncate BEFORE TRUNCATE ON prescription_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_billing();
--> statement-breakpoint
DROP TRIGGER IF EXISTS gkv_deductions_fk_same_org ON gkv_deductions;
--> statement-breakpoint
CREATE TRIGGER gkv_deductions_fk_same_org BEFORE INSERT OR UPDATE OF prescription_id, patient_id, billing_batch_id, organization_id ON gkv_deductions
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('prescription_id', 'prescriptions', 'patient_id', 'patients', 'billing_batch_id', 'billing_batches');
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescription_corrections_fk_same_org ON prescription_corrections;
--> statement-breakpoint
CREATE TRIGGER prescription_corrections_fk_same_org BEFORE INSERT OR UPDATE OF prescription_id, patient_id, deduction_id, original_batch_id, resolved_batch_id, organization_id ON prescription_corrections
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('prescription_id', 'prescriptions', 'patient_id', 'patients', 'deduction_id', 'gkv_deductions', 'original_batch_id', 'billing_batches', 'resolved_batch_id', 'billing_batches');
--> statement-breakpoint
DROP TRIGGER IF EXISTS gkv_deductions_user_in_org ON gkv_deductions;
--> statement-breakpoint
CREATE TRIGGER gkv_deductions_user_in_org BEFORE INSERT OR UPDATE OF created_by, updated_by, organization_id ON gkv_deductions
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor', 'updated_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescription_corrections_user_in_org ON prescription_corrections;
--> statement-breakpoint
CREATE TRIGGER prescription_corrections_user_in_org BEFORE INSERT OR UPDATE OF created_by, resolved_by, organization_id ON prescription_corrections
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor', 'resolved_by', 'actor');
--> statement-breakpoint
-- Bestätigung des Kennzeichens Verordnungsart: Person der Praxis (wie created_by, 0056)
DROP TRIGGER IF EXISTS prescriptions_user_in_org ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_user_in_org BEFORE INSERT OR UPDATE OF created_by, prescription_kind_confirmed_by, organization_id ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor', 'prescription_kind_confirmed_by', 'actor');
--> statement-breakpoint
-- Abgerechnete Verordnung (zuletzt 0062): unverändert gesperrt bis auf den Altvermerk – einzige Ausnahme ist der
-- Wechsel „abgerechnet“ → „Korrektur nötig“ (nur der Status), und nur mit offenem Korrekturvermerk
-- (prescription_corrections, im selben Vorgang angelegt). Damit gibt es keine stille Änderung einer abgerechneten
-- Verordnung: Der Stand der Erstabrechnung steht im Korrekturvermerk, jede weitere Änderung im Audit-Protokoll.
CREATE OR REPLACE FUNCTION podo_prescription_billed_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  allowed text[] := ARRAY['copayment_paid_at', 'copayment_paid_cents', 'copayment_paid_method'];
BEGIN
  IF OLD.status = 'billed' AND NEW.status = 'correction_needed'
     AND (to_jsonb(NEW) - allowed - 'status') = (to_jsonb(OLD) - allowed - 'status')
     AND EXISTS (SELECT 1 FROM prescription_corrections c
                  WHERE c.prescription_id = NEW.id AND c.organization_id = NEW.organization_id AND c.resolved_at IS NULL) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'billed' AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Abgerechnete Verordnung ist unveränderbar (Korrektur nur über „Korrektur nötig“ mit Begründung).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_billed_lock() FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TABLE gkv_deductions IS
  'Absetzung/Retaxe der Krankenkasse zu einer abgerechneten Verordnung (Betrag, Grund/Code, Datum, Status) – GKV Paket C, Migration 0066.';
--> statement-breakpoint
COMMENT ON TABLE prescription_corrections IS
  'Korrektur einer abgerechneten Verordnung mit Stand der Erstabrechnung; Voraussetzung für abgerechnet → Korrektur nötig (Migration 0066).';
--> statement-breakpoint
COMMENT ON COLUMN prescriptions.prescription_kind IS
  'Kennzeichen Verordnungsart (Anlage 3 § 302 V21 8.1.12): 03 oder 04, von Nutzer:innen bestätigt; NULL = nicht bestätigt.';
--> statement-breakpoint
-- podo_delete_patient (zuletzt 0065): Absetzungen und Korrekturvermerke sind Abrechnungsunterlagen (Rückmeldungen der
-- Kasse) – Grund gegen die vollständige Löschung. Sonst unverändert; fester search_path, Rechte wie 0062.
CREATE OR REPLACE FUNCTION podo_delete_patient(p_patient uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  n int;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'Kein Praxis-Kontext.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM treatment_records WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM therapy_reports WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM anamneses WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM invoices WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM media WHERE organization_id = org AND patient_id = p_patient AND record_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM gkv_deductions WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM prescription_corrections WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM prescriptions WHERE organization_id = org AND patient_id = p_patient
                  AND (billed_at IS NOT NULL OR copayment_paid_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Aufbewahrungspflichtige Daten vorhanden – vollständige Löschung nicht zulässig.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('podo.patient_delete', p_patient::text, true);
  DELETE FROM appointments WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM messages WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM voice_calls WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM media WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM patients WHERE id = p_patient AND organization_id = org;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('podo.patient_delete', '', true);
  RETURN n = 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_delete_patient(uuid) FROM PUBLIC;
