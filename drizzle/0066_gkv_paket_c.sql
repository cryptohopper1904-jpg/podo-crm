-- GKV Paket C: Kennzeichen Verordnungsart, Verordnungsbesonderheiten, Genehmigung (SKZ B2), Absetzungen/Retaxen und
-- Korrektur abgerechneter Verordnungen.
--
-- 1. prescriptions: prescription_kind ('03' | '04', Anlage 3 zu § 302 V21 8.1.12) mit Bestätigung (wer/wann),
--    prescription_special (8.1.11), approval_ref/approval_date (Genehmigung langfristiger Heilmittelbedarf, SKZ, Art B2,
--    8.1.17). Bestand bleibt NULL = nicht bestätigt (keine Abrechnungsreife, kein § 302-Export – nie „03“ raten).
--    ADD COLUMN/ADD CONSTRAINT lösen keine Zeilen-Trigger aus: abgerechnete Zeilen (prescriptions_billed_lock) bleiben
--    unberührt.
-- 2. gkv_deductions: Absetzung/Retaxe der Kasse zu einer abgerechneten Verordnung (Betrag, Grund/Code, Datum, Status
--    offen/akzeptiert/Widerspruch/erledigt, Notiz, Aktenzeichen/Datum des Kassenschreibens, Ausgang bei „erledigt“:
--    upheld/reversed). Betrag/Grund/Datum nur „offen“ änderbar, Bezug unveränderlich,
--    nie löschbar (außer mit der Person: podo_owner_delete_allowed wie 0019/0065 – podo_delete_patient verweigert das
--    aber, solange eine Absetzung existiert).
-- 3. prescription_corrections: nachvollziehbare Korrektur einer abgerechneten Verordnung. Hält den Stand der
--    Erstabrechnung fest (Lauf, Zeitpunkt, Beträge, Preis-Snapshot und die vollständige Verordnungszeile original_row,
--    vom Trigger gesetzt) und ist Voraussetzung für den einzigen erlaubten Wechsel aus „abgerechnet“: → „Korrektur
--    nötig“ (correction_needed). Erledigt durch erneute Abrechnung (rebilled, nur mit dem Lauf, der die Verordnung
--    enthält) oder ohne Neuabrechnung (no_rebill, nur wenn die Verordnung inhaltlich original_row entspricht); danach
--    unveränderlich. Stand der Erstabrechnung (original_*, original_row) und created_at setzt immer der Trigger, nie die
--    Anwendung. Neuabrechnung nur in einem neuen Lauf (jünger als der jüngste Vermerk, nie der Lauf einer
--    Erstabrechnung); „ohne Neuabrechnung“ nur zusammen mit der Rückkehr auf „abgerechnet“ im alten Lauf (Prüfung beim
--    Commit, CONSTRAINT TRIGGER).
-- 4. billing_batches_org_id: eindeutiger Index (organization_id, id) für den Lookup in podo_fk_same_org.
-- 5. billing_batches: Abrechnungsläufe nie löschbar (Abrechnungsunterlage, Laufnummer in der Auswertung), created_at vom
--    Server; nach dem Anlegen unveränderlich bis auf die Übergabe (exported_at einmalig, Status draft → exported).
--    „Abgerechnet“ (aus abrechnungsreif) nur in einen Lauf, der im selben Vorgang angelegt und nicht übergeben ist.
--    Endgültige Löschung der Praxis schaltet Trigger ab.
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
	"letter_ref" text,
	"letter_date" date,
	"outcome" text,
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
	"original_row" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolved_batch_id" uuid,
	"resolution_note" text
);
--> statement-breakpoint
-- Spalten aus Review-Runde 1 (Paket C noch nicht ausgeliefert): für Datenbanken, in denen die Tabellen schon bestehen.
-- Erst nachsehen, dann ALTER – ADD COLUMN IF NOT EXISTS nimmt sonst auch bei vorhandener Spalte die exklusive Tabellensperre
-- (Wiederholung der Migration neben laufenden Abfragen, Deadlock-Gefahr).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'gkv_deductions' AND column_name = 'letter_ref') THEN
    ALTER TABLE "gkv_deductions" ADD COLUMN "letter_ref" text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'gkv_deductions' AND column_name = 'letter_date') THEN
    ALTER TABLE "gkv_deductions" ADD COLUMN "letter_date" date;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'gkv_deductions' AND column_name = 'outcome') THEN
    ALTER TABLE "gkv_deductions" ADD COLUMN "outcome" text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prescription_corrections' AND column_name = 'original_row') THEN
    ALTER TABLE "prescription_corrections" ADD COLUMN "original_row" jsonb;
  END IF;
END $$;
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
  -- Kassenschreiben (Aktenzeichen/Datum, optional) und Ausgang: „erledigt“ ⇔ Ausgang gesetzt (upheld = Absetzung
  -- bleibt, reversed = Widerspruch erfolgreich)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_outcome_check') THEN
    ALTER TABLE gkv_deductions ADD CONSTRAINT gkv_deductions_outcome_check CHECK (
      (outcome IS NULL OR outcome IN ('upheld', 'reversed'))
      AND (status = 'done') = (outcome IS NOT NULL)
      AND coalesce(char_length(letter_ref), 0) <= 60);
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
  vo_row jsonb;
  vo_batch uuid;
  vo_billed timestamptz;
  vo_remedy int;
  vo_copay int;
  vo_snapshot jsonb;
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
    -- erneut abgerechnet nur mit dem Lauf, der die Verordnung jetzt enthält; ohne Neuabrechnung ohne Lauf
    IF NEW.resolution = 'rebilled' AND NOT EXISTS (
         SELECT 1 FROM prescriptions p WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id
            AND p.billing_batch_id = NEW.resolved_batch_id AND p.status = 'billed') THEN
      RAISE EXCEPTION 'Der Lauf der Neuabrechnung enthält die Verordnung nicht.' USING ERRCODE = 'P0001';
    END IF;
    -- … und nie mit dem Lauf der Erstabrechnung (AppSec Runde 2, S1)
    IF NEW.resolution = 'rebilled' AND (NEW.resolved_batch_id IS NOT DISTINCT FROM (OLD.original_row->>'billing_batch_id')::uuid
                                        OR NEW.resolved_batch_id IS NOT DISTINCT FROM OLD.original_batch_id) THEN
      RAISE EXCEPTION 'Neuabrechnung nur in einem neuen Abrechnungslauf, nicht im Lauf der Erstabrechnung.' USING ERRCODE = 'P0001';
    END IF;
    -- … und nur mit einem Lauf, der in diesem Vorgang angelegt und noch nicht übergeben ist (AppSec Runde 3, N1)
    IF NEW.resolution = 'rebilled' AND NOT EXISTS (
         SELECT 1 FROM billing_batches b WHERE b.id = NEW.resolved_batch_id AND b.organization_id = NEW.organization_id
            AND b.created_at = now() AND b.exported_at IS NULL) THEN
      RAISE EXCEPTION 'Neuabrechnung nur in einem neuen Abrechnungslauf, der im selben Vorgang angelegt und noch nicht übergeben ist.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.resolution = 'no_rebill' AND NEW.resolved_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'Ohne Neuabrechnung gibt es keinen neuen Lauf.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.patient_id, p.status, to_jsonb(p), p.billing_batch_id, p.billed_at, p.remedy_cost_cents, p.copayment_cents, p.price_snapshot
    INTO vo_patient, vo_status, vo_row, vo_batch, vo_billed, vo_remedy, vo_copay, vo_snapshot
    FROM prescriptions p
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
  -- Stand der Erstabrechnung: immer die aktuelle (abgerechnete, gesperrte) Zeile – nie ein Wert der Anwendung (auch
  -- Lauf, Zeitpunkt, Beträge und Snapshot; AppSec Runde 2, S2), Anlagezeitpunkt vom Server (S4)
  NEW.original_row := vo_row;
  NEW.original_batch_id := vo_batch;
  NEW.original_billed_at := vo_billed;
  NEW.original_remedy_cost_cents := vo_remedy;
  NEW.original_copayment_cents := vo_copay;
  NEW.original_price_snapshot := vo_snapshot;
  NEW.created_at := now();
  NEW.resolved_by := NULL;
  NEW.resolved_batch_id := NULL;
  NEW.resolution_note := NULL;
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
-- „Ohne Neuabrechnung“ abgeschlossen ⇒ beim Commit ist die Verordnung wieder „abgerechnet“ im Lauf der Erstabrechnung
-- (Code-Review H-1: sonst bliebe sie mit abgeschlossenem Vermerk in „Korrektur nötig“ bzw. „abrechnungsreif“ stehen)
CREATE OR REPLACE FUNCTION podo_prescription_correction_no_rebill_check() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.resolution = 'no_rebill' AND NOT EXISTS (
       SELECT 1 FROM prescriptions p WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id
          AND p.status = 'billed' AND p.billing_batch_id IS NOT DISTINCT FROM NEW.original_batch_id) THEN
    RAISE EXCEPTION '„Ohne Neuabrechnung“ nur zusammen mit der Rückkehr auf „abgerechnet“ im Lauf der Erstabrechnung.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_correction_no_rebill_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescription_corrections_no_rebill_check ON prescription_corrections;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER prescription_corrections_no_rebill_check AFTER UPDATE OF resolution ON prescription_corrections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION podo_prescription_correction_no_rebill_check();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_no_truncate_gkv_billing() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Abrechnungsläufe, Absetzungen und Korrekturvermerke können nicht geleert werden.' USING ERRCODE = 'P0001';
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
-- Abgerechnete Verordnung (zuletzt 0062): unverändert gesperrt bis auf den Altvermerk. Ausnahmen (GKV Paket C):
-- 1. „abgerechnet“ → „Korrektur nötig“ (nur der Status), nur mit offenem Korrekturvermerk (im selben Vorgang angelegt).
-- 2. „Korrektur nötig“ wird nur mit offenem Vermerk betreten (auch aus „abrechnungsreif“ zurück, solange der Vermerk
--    offen ist).
-- 3. „Korrektur nötig“ → „abgerechnet“ (ohne Neuabrechnung) nur, wenn der jüngste Vermerk im selben Vorgang
--    (resolved_at = now()) als no_rebill abgeschlossen wurde, kein Vermerk mehr offen ist und die Zeile inhaltlich dem
--    Stand der Erstabrechnung (original_row) entspricht – ohne Status und Altvermerk Zuzahlung (eine Neubestätigung des
--    Kennzeichens zählt als Änderung, AppSec Runde 2, S3); Preis-Snapshot, Heilmittelkosten und Zuzahlung müssen wieder der Erstabrechnung entsprechen.
-- 4. Hat die Verordnung Korrekturvermerke, geht es aus anderen Status (abrechnungsreif) nur in einem NEUEN Lauf auf
--    „abgerechnet“: Lauf vorhanden, nicht der Lauf einer Erstabrechnung (original_row) und nicht älter als der jüngste
--    Vermerk (AppSec Runde 2, S1 – sonst „rebilled“ mit dem alten Lauf, dessen Summe die Änderung nicht enthält).
-- 5. Jeder Wechsel aus einem anderen Status (abrechnungsreif) nach „abgerechnet“ nur in einen Lauf, der im selben Vorgang
--    angelegt (created_at = now(), vom Server gesetzt) und noch nicht übergeben ist (exported_at IS NULL) – so wie
--    createBillingBatch es tut (AppSec Runde 3, N1/N3: sonst stünde die Verordnung in einem fremden, schon übergebenen
--    Lauf, dessen Summe sie nicht enthält). Übernahmen legen abgerechnete Verordnungen per INSERT an (nicht betroffen).
-- 6. billing_batch_id ändert sich nur zusammen mit dem Wechsel nach 5.; beim INSERT nur NULL oder ein Lauf, der im selben
--    Vorgang angelegt und nicht übergeben ist (podo_prescription_batch_insert_guard, AppSec Runde 4, R1).
-- Damit gibt es keine stille Änderung einer abgerechneten Verordnung: Der Stand der Erstabrechnung steht im
-- Korrekturvermerk, jede Änderung im Korrekturstatus im Audit-Protokoll (Feldnamen), und zurück auf „abgerechnet“ im
-- alten Lauf geht es nur unverändert – sonst Neuabrechnung.
CREATE OR REPLACE FUNCTION podo_prescription_billed_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  allowed text[] := ARRAY['copayment_paid_at', 'copayment_paid_cents', 'copayment_paid_method'];
  volatile text[] := ARRAY['status', 'copayment_paid_at', 'copayment_paid_cents', 'copayment_paid_method'];
  c record;
BEGIN
  IF NEW.status = 'correction_needed' AND OLD.status IS DISTINCT FROM 'correction_needed'
     AND NOT EXISTS (SELECT 1 FROM prescription_corrections pc
                      WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id AND pc.resolved_at IS NULL) THEN
    RAISE EXCEPTION '„Korrektur nötig“ nur mit offenem Korrekturvermerk.' USING ERRCODE = 'check_violation';
  END IF;
  -- Lauf einer Verordnung ändert sich nur beim geprüften Abrechnen (unten, Regel 5) – sonst stünde sie in einem fremden
  -- (übergebenen) Lauf, dessen Summe sie nicht enthält (AppSec Runde 4, R1)
  IF NEW.billing_batch_id IS DISTINCT FROM OLD.billing_batch_id
     AND NOT (NEW.status = 'billed' AND OLD.status NOT IN ('billed', 'correction_needed')) THEN
    RAISE EXCEPTION 'Der Abrechnungslauf einer Verordnung wird nur beim Abrechnen in einem neuen Abrechnungslauf gesetzt.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'billed' AND NEW.status = 'correction_needed'
     AND (to_jsonb(NEW) - allowed - 'status') = (to_jsonb(OLD) - allowed - 'status') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'billed' AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Abgerechnete Verordnung ist unveränderbar (Korrektur nur über „Korrektur nötig“ mit Begründung).'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'billed' AND OLD.status NOT IN ('billed', 'correction_needed')
     AND EXISTS (SELECT 1 FROM prescription_corrections pc WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id)
     AND (NEW.billing_batch_id IS NULL
          OR EXISTS (SELECT 1 FROM prescription_corrections pc
                      WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id
                        AND (NEW.billing_batch_id = (pc.original_row->>'billing_batch_id')::uuid OR NEW.billing_batch_id = pc.original_batch_id))
          OR NOT EXISTS (SELECT 1 FROM billing_batches b
                          WHERE b.id = NEW.billing_batch_id AND b.organization_id = NEW.organization_id
                            AND b.created_at >= (SELECT max(pc.created_at) FROM prescription_corrections pc
                                                  WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id))) THEN
    RAISE EXCEPTION 'Nach einer Korrektur nur in einem neuen Abrechnungslauf abrechnen.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'billed' AND OLD.status NOT IN ('billed', 'correction_needed')
     AND NOT EXISTS (SELECT 1 FROM billing_batches b
                      WHERE b.id = NEW.billing_batch_id AND b.organization_id = NEW.organization_id
                        AND b.created_at = now() AND b.exported_at IS NULL) THEN
    RAISE EXCEPTION '„Abgerechnet“ nur über einen neuen Abrechnungslauf (im selben Vorgang angelegt, noch nicht übergeben).' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'correction_needed' AND NEW.status = 'billed' THEN
    SELECT pc.resolution, pc.resolved_at, pc.original_row INTO c FROM prescription_corrections pc
     WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id
     ORDER BY pc.created_at DESC, pc.id DESC LIMIT 1;
    IF c.resolution IS DISTINCT FROM 'no_rebill' OR c.resolved_at IS DISTINCT FROM now() OR c.original_row IS NULL
       OR EXISTS (SELECT 1 FROM prescription_corrections pc
                   WHERE pc.prescription_id = NEW.id AND pc.organization_id = NEW.organization_id AND pc.resolved_at IS NULL) THEN
      RAISE EXCEPTION 'Zurück auf „abgerechnet“ nur über „ohne Neuabrechnung abschließen“.' USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - volatile) IS DISTINCT FROM (c.original_row - volatile) THEN
      RAISE EXCEPTION 'Geänderte Verordnung muss neu abgerechnet werden.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_billed_lock() FROM PUBLIC;
--> statement-breakpoint
-- Neue Verordnung mit Lauf (AppSec Runde 4, R1): nur ein Lauf derselben Praxis, der im selben Vorgang angelegt und noch
-- nicht übergeben ist (wie createBillingBatch); Übernahmen schreiben keinen Lauf (NULL)
CREATE OR REPLACE FUNCTION podo_prescription_batch_insert_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.billing_batch_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM billing_batches b WHERE b.id = NEW.billing_batch_id AND b.organization_id = NEW.organization_id
          AND b.created_at = now() AND b.exported_at IS NULL) THEN
    RAISE EXCEPTION 'Eine neue Verordnung kann nur einem eben angelegten, nicht übergebenen Abrechnungslauf zugeordnet werden.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_batch_insert_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_batch_insert_guard ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_batch_insert_guard BEFORE INSERT ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_prescription_batch_insert_guard();
--> statement-breakpoint
-- Abrechnungslauf (seit 0006): nie löschbar, Anlagezeitpunkt vom Server. Nach dem Anlegen unveränderlich bis auf die
-- Übergabe (AppSec Runde 3, N2): exported_at nur einmal NULL → Zeitpunkt, Status nur gleich oder draft → exported. Summen,
-- Anzahl, Partner und Notiz bleiben der Stand des Laufs. Beim Anlegen immer Entwurf ohne Übergabe; die Übergabe nur
-- zusammen mit dem Status „exported“, Zeitpunkt vom Server (AppSec Runde 4, R3). Endgültige Löschung der Praxis
-- (purge-organization) schaltet die Trigger ab.
-- HINWEIS für künftige Daten-Migrationen auf billing_batches (z. B. Summen nachtragen): der Guard lehnt jede solche
-- Änderung ab – in der Migration vorher `ALTER TABLE billing_batches DISABLE TRIGGER billing_batches_guard` und danach
-- wieder `ENABLE` (Eigentümer, in derselben Transaktion), sonst bricht der Deploy ab.
CREATE OR REPLACE FUNCTION podo_billing_batch_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Ein Abrechnungslauf kann nicht gelöscht werden (Abrechnungsunterlage).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.exported_at := NULL;
    NEW.status := 'draft';
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'exported_at' - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'exported_at' - 'status') THEN
    RAISE EXCEPTION 'Ein Abrechnungslauf ist unveränderlich (nur die Übergabe wird vermerkt).' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.exported_at IS NOT NULL AND NEW.exported_at IS DISTINCT FROM OLD.exported_at THEN
    RAISE EXCEPTION 'Der Übergabezeitpunkt eines übergebenen Abrechnungslaufs ist unveränderlich.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.exported_at IS DISTINCT FROM OLD.exported_at THEN
    IF NEW.status IS DISTINCT FROM 'exported' THEN
      RAISE EXCEPTION 'Übergabe eines Abrechnungslaufs nur zusammen mit dem Status „übergeben“.' USING ERRCODE = 'P0001';
    END IF;
    NEW.exported_at := now();
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'draft' AND NEW.status = 'exported' AND OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Status des Abrechnungslaufs unveränderlich (nur „Entwurf“ → „übergeben“ mit der Übergabe).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_billing_batch_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batches_guard ON billing_batches;
--> statement-breakpoint
CREATE TRIGGER billing_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_batches
  FOR EACH ROW EXECUTE FUNCTION podo_billing_batch_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batches_no_truncate ON billing_batches;
--> statement-breakpoint
CREATE TRIGGER billing_batches_no_truncate BEFORE TRUNCATE ON billing_batches
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_billing();
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
