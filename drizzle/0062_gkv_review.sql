-- GKV-Grundlagen, Review-Runde 1 (PR #111, docs/GKV.md). Idempotent (IF NOT EXISTS / DROP … IF EXISTS / OR REPLACE).
--  - Wiederaufnahme aus „Frist überschritten“ mit Pflichtbegründung (reopened_at, reopen_note) – Code-Review C1
--  - Zuzahlung erhalten: Betrag und Zahlungsart (Vorbereitung Quittung, Paket B) – Buchhaltung „Klein“
--  - appointments.prescription_id: FK (ON DELETE SET NULL) und Praxis-Abgleich im Trigger appointments_fk_same_org – AppSec A1
--  - höchstens 50 Befreiungsbescheinigungen je Person – AppSec A5
--  - abgerechnete Verordnung (status billed) unveränderbar, außer „Zuzahlung erhalten“ – Buchhaltung S1
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
-- Verweise auf nicht (mehr) vorhandene Verordnungen (Spalte war bisher ohne FK) vor dem FK leeren – sie zeigen ins Leere.
UPDATE appointments a SET prescription_id = NULL
 WHERE a.prescription_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = a.prescription_id);
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
CREATE OR REPLACE FUNCTION podo_prescription_billed_lock() RETURNS trigger LANGUAGE plpgsql AS $$
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
