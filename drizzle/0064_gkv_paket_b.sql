-- GKV Paket B (Teil 1): Unterschrift je Behandlung (Leistungsnachweis) und Zuzahlungsquittung.
--
-- 1. treatment_signatures – Bestätigung der versicherten Person je Behandlungseintrag (Vertrag § 125 SGB V Podologie,
--    Anlage 3 Buchst. o): Unterschrift auf dem Gerät (PNG verschlüsselt in der Dateiablage, Schlüssel
--    „<organization_id>/…/<uuid>.bin“ wie document_archive – nie als Blob in der DB) mit Name und Rolle, oder der bewusst
--    gesetzte Vermerk „Unterschrift auf der Papier-Verordnung (Rückseite)“. Je Eintrag höchstens einmal (eindeutiger
--    Index), append-only (kein UPDATE/DELETE/TRUNCATE; gelöscht wird nur mit der ganzen Praxis, Löschlauf schaltet die
--    Trigger generisch ab). Behandlungseintrag, Person und Verordnung müssen zusammenpassen (Trigger), Verweise nur
--    innerhalb der Praxis (podo_fk_same_org, podo_user_in_org), RLS + FORCE wie alle Praxis-Tabellen.
-- 2. Zuzahlungsquittung: neue Belegart invoice_kind 'copayment' und invoices.prescription_id. Die Zuzahlung läuft damit
--    über den bestehenden Beleg-/Zahlungsweg (Nummernkreis, Beleg-Archiv, Kasse/TSE bzw. Vermerk der eigenen
--    Praxiskasse, Z-Bon, DSFinV-K) – keine zweite Kasse. CHECK: prescription_id genau bei 'copayment' (Vergleich über
--    kind::text, weil ein neuer Enum-Wert in derselben Transaktion nicht als Literal verwendet werden darf).
--    Die bisherigen Vermerke prescriptions.copayment_paid_* bleiben unverändert (nur Anzeige als „Altvermerk“, keine
--    nachträgliche Kassenbuchung) – keine Datenmigration.
-- Alle neuen Funktionen mit festem search_path (Katalogtest). Idempotent: IF NOT EXISTS, Constraints nur wenn fehlend,
-- CREATE OR REPLACE, DROP TRIGGER/POLICY IF EXISTS.
ALTER TYPE "public"."invoice_kind" ADD VALUE IF NOT EXISTS 'copayment';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treatment_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid,
	"kind" text NOT NULL,
	"signer_name" text,
	"signer_role" text,
	"storage_key" text,
	"mime" text,
	"size_bytes" integer,
	"sha256" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "prescription_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_organization_id_organizations_id_fk') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_record_id_treatment_records_id_fk') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_record_id_treatment_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."treatment_records"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_patient_id_patients_id_fk') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_created_by_users_id_fk') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  -- Gerät: PNG in der Ablage der eigenen Praxis, höchstens 200 KB, Name (2–120 Zeichen) und Rolle Pflicht.
  -- Papier: keine Datei; Name/Rolle optional.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_signatures_values_check') THEN
    ALTER TABLE "treatment_signatures" ADD CONSTRAINT "treatment_signatures_values_check" CHECK (
      (signer_role IS NULL OR signer_role IN ('insured', 'caregiver', 'relative'))
      AND (signer_name IS NULL OR char_length(btrim(signer_name)) BETWEEN 2 AND 120)
      AND (
        (kind = 'device' AND signer_name IS NOT NULL AND signer_role IS NOT NULL AND mime = 'image/png'
          AND size_bytes BETWEEN 1 AND 200000 AND sha256 ~ '^[0-9a-f]{64}$' AND length(storage_key) BETWEEN 1 AND 300
          AND starts_with(storage_key, organization_id::text || '/') AND storage_key ~ '^[a-z0-9/-]+\.bin$')
        OR (kind = 'paper' AND storage_key IS NULL AND mime IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_prescription_kind_check') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_prescription_kind_check" CHECK ((prescription_id IS NOT NULL) = (kind::text = 'copayment'));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treatment_signatures_record" ON "treatment_signatures" USING btree ("record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treatment_signatures_org_prescription" ON "treatment_signatures" USING btree ("organization_id","prescription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_org_prescription" ON "invoices" USING btree ("organization_id","prescription_id");
--> statement-breakpoint
ALTER TABLE "treatment_signatures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "treatment_signatures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "treatment_signatures";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "treatment_signatures"
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Behandlungseintrag, Person und Verordnung müssen zusammenpassen (die Verordnung der Unterschrift ist die des Eintrags).
-- Triggername nach „…_fk_same_org“ (Postgres feuert alphabetisch): Verweise in eine fremde Praxis meldet zuerst
-- podo_fk_same_org (23503), diese Prüfung sieht unter RLS ohnehin nur Einträge der eigenen Praxis.
CREATE OR REPLACE FUNCTION podo_treatment_signature_check() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r_patient uuid; r_prescription uuid; ok boolean;
BEGIN
  SELECT true, t.patient_id, t.prescription_id INTO ok, r_patient, r_prescription
    FROM treatment_records t WHERE t.id = NEW.record_id AND t.organization_id = NEW.organization_id;
  IF ok IS NOT TRUE OR r_patient IS DISTINCT FROM NEW.patient_id OR r_prescription IS DISTINCT FROM NEW.prescription_id THEN
    RAISE EXCEPTION 'Unterschrift passt nicht zum Behandlungseintrag.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_treatment_signature_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_signatures_record_match ON treatment_signatures;
--> statement-breakpoint
CREATE TRIGGER treatment_signatures_record_match BEFORE INSERT ON treatment_signatures
  FOR EACH ROW EXECUTE FUNCTION podo_treatment_signature_check();
--> statement-breakpoint
-- Unveränderlich nach dem Speichern (Leistungsnachweis gegenüber der Krankenkasse)
CREATE OR REPLACE FUNCTION podo_treatment_signature_immutable() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Eine erfasste Unterschrift ist unveränderbar und kann weder geändert noch gelöscht werden.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_treatment_signature_immutable() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_signatures_immutable ON treatment_signatures;
--> statement-breakpoint
CREATE TRIGGER treatment_signatures_immutable BEFORE UPDATE OR DELETE ON treatment_signatures
  FOR EACH ROW EXECUTE FUNCTION podo_treatment_signature_immutable();
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_signatures_no_truncate ON treatment_signatures;
--> statement-breakpoint
CREATE TRIGGER treatment_signatures_no_truncate BEFORE TRUNCATE ON treatment_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION podo_treatment_signature_immutable();
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_signatures_fk_same_org ON treatment_signatures;
--> statement-breakpoint
CREATE TRIGGER treatment_signatures_fk_same_org BEFORE INSERT OR UPDATE OF record_id, patient_id, prescription_id, organization_id ON treatment_signatures
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('record_id', 'treatment_records', 'patient_id', 'patients', 'prescription_id', 'prescriptions');
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_signatures_user_in_org ON treatment_signatures;
--> statement-breakpoint
CREATE TRIGGER treatment_signatures_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON treatment_signatures
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
-- Zuzahlungsquittung: Verordnung nur aus derselben Praxis (wie 0054, um prescription_id ergänzt)
DROP TRIGGER IF EXISTS invoices_fk_same_org ON invoices;
--> statement-breakpoint
CREATE TRIGGER invoices_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, billing_contact_id, prescription_id, organization_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'billing_contact_id', 'billing_contacts', 'prescription_id', 'prescriptions');
--> statement-breakpoint
COMMENT ON TABLE treatment_signatures IS
  'Bestätigung der versicherten Person je Behandlung (Leistungsnachweis GKV, Anlage 3 Buchst. o): Unterschrift auf dem Gerät (PNG verschlüsselt in der Dateiablage) oder Vermerk Papier-Verordnung. Append-only (Migration 0064).';
--> statement-breakpoint
COMMENT ON COLUMN invoices.prescription_id IS
  'Zuzahlungsquittung (kind copayment): Verordnung, deren Zuzahlung quittiert wird (Migration 0064).';
