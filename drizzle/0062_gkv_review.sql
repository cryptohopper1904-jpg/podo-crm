-- GKV-Grundlagen, Review-Runde 1 (PR #111, docs/GKV.md). Idempotent (IF NOT EXISTS / DROP … IF EXISTS / OR REPLACE).
--  - Wiederaufnahme aus „Frist überschritten“ mit Pflichtbegründung (reopened_at, reopen_note) – Code-Review C1
--  - Zuzahlung erhalten: Betrag und Zahlungsart (Vorbereitung Quittung, Paket B) – Buchhaltung „Klein“
--  - appointments.prescription_id: FK (ON DELETE SET NULL) und Praxis-Abgleich im Trigger appointments_fk_same_org – AppSec A1
--  - höchstens 50 Befreiungsbescheinigungen je Person – AppSec A5
--  - abgerechnete Verordnung (status billed) unveränderbar, außer „Zuzahlung erhalten“ – Buchhaltung S1
-- Review-Runde 2:
--  - Bereinigung der Termin-Verweise mit ausgesetztem FORCE RLS (sonst sieht der Eigentümer keine Verordnungen und
--    hätte ALLE Verweise geleert) + Verweise auf Verordnungen anderer Praxen leeren; Index auf prescription_id
--  - search_path an podo_prescription_billed_lock
--  - podo_delete_patient: abgerechnete Verordnungen bzw. erhaltene Zuzahlung sind aufbewahrungspflichtig – AppSec N1
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "reopened_at" date;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "reopen_note" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "copayment_paid_cents" integer;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "copayment_paid_method" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_copayment_paid_check') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_copayment_paid_check CHECK (
      (copayment_paid_cents IS NULL OR copayment_paid_cents >= 0)
      AND (copayment_paid_method IS NULL OR copayment_paid_method IN ('cash', 'card', 'transfer', 'other')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_copayment_exemptions_max') THEN
    -- jsonb_typeof zuerst: jsonb_array_length scheitert an Nicht-Arrays (die lehnt patients_copayment_exemptions_check ab)
    ALTER TABLE patients ADD CONSTRAINT patients_copayment_exemptions_max CHECK (
      jsonb_typeof(copayment_exemptions) <> 'array' OR jsonb_array_length(copayment_exemptions) <= 50);
  END IF;
END $$;
--> statement-breakpoint
-- Datenbereinigung als Tabelleneigentümer: FORCE RLS gilt auch für den Eigentümer – ohne app.org_id sähe die
-- Unterabfrage KEINE Verordnung und das UPDATE leerte jeden Verweis (bzw. änderte nichts). Für beide Tabellen für die
-- Dauer der Bereinigung aussetzen (Muster wie 0017) und direkt danach wieder einschalten.
ALTER TABLE appointments NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE prescriptions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Verweise auf nicht (mehr) vorhandene Verordnungen (Spalte war bisher ohne FK) vor dem FK leeren – sie zeigen ins Leere.
UPDATE appointments a SET prescription_id = NULL
 WHERE a.prescription_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = a.prescription_id);
--> statement-breakpoint
-- Verweise auf Verordnungen einer anderen Praxis leeren (der Trigger unten lehnt sie künftig ab).
UPDATE appointments a SET prescription_id = NULL
  FROM prescriptions p
 WHERE p.id = a.prescription_id
   AND p.organization_id <> a.organization_id;
--> statement-breakpoint
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE prescriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_prescription_id" ON "appointments" USING btree ("prescription_id") WHERE "appointments"."prescription_id" is not null;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_prescription_id_prescriptions_id_fk') THEN
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
-- Praxis-Abgleich wie Migration 0054 (podo_fk_same_org), jetzt auch für prescription_id (inkl. UPDATE OF).
DROP TRIGGER IF EXISTS appointments_fk_same_org ON appointments;
--> statement-breakpoint
CREATE TRIGGER appointments_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, location_id, prescription_id, organization_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'location_id', 'locations', 'prescription_id', 'prescriptions');
--> statement-breakpoint
-- Abgerechnet = an das Abrechnungszentrum übergeben: Preis-Snapshot, Positionen, Beträge und Status bleiben so, wie sie
-- abgerechnet wurden (GoBD-Unveränderbarkeit, Nachvollziehbarkeit gegenüber der Kasse). Erlaubt bleibt nur „Zuzahlung
-- erhalten“ (Datum, Betrag, Zahlungsart). Eine Korrektur/Storno eines Abrechnungslaufs ist noch nicht vorgesehen
-- (docs/GKV.md, offene Punkte).
CREATE OR REPLACE FUNCTION podo_prescription_billed_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  allowed text[] := ARRAY['copayment_paid_at', 'copayment_paid_cents', 'copayment_paid_method'];
BEGIN
  IF OLD.status = 'billed' AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Abgerechnete Verordnung ist unveränderbar (nur „Zuzahlung erhalten“ darf nachgetragen werden).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_billed_lock ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_billed_lock BEFORE UPDATE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_prescription_billed_lock();
--> statement-breakpoint
-- Trigger-Funktion (nicht direkt aufrufbar) – Rechte wie podo_invoice_lines_guard (0057)
REVOKE ALL ON FUNCTION podo_prescription_billed_lock() FROM PUBLIC;
--> statement-breakpoint
-- podo_delete_patient (zuletzt 0057): Abgerechnete Verordnungen (billed_at) und erhaltene Zuzahlungen
-- (copayment_paid_at) sind Abrechnungs-/Buchungsunterlagen und dürfen nicht mit der Person gelöscht werden
-- (prescriptions hängt per ON DELETE CASCADE an patients) – AppSec N1. Dieselbe Prüfung macht
-- src/server/patient-deletion.ts (retentionFacts). Sonst unverändert; SET search_path wie seit 0056, Rechte:
-- REVOKE … FROM PUBLIC wiederholt (0057), GRANT an die App-Rolle in scripts/migrate.ts.
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
     OR EXISTS (SELECT 1 FROM anamneses WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM invoices WHERE organization_id = org AND patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM media WHERE organization_id = org AND patient_id = p_patient AND record_id IS NOT NULL)
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
