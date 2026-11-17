-- GKV-Grundlagen (Paket A, docs/GKV.md): Stammdaten der Kassenzulassung (Praxis-IK, LEGS, Zulassung), Kassen-IK und
-- Versichertenstatus je Person, Befreiungsbescheinigungen, Pflichtangaben der Verordnung nach Anlage 3 Podologie,
-- Preis-Snapshot je Verordnung und Heilmittelkosten im Abrechnungslauf. Idempotent (IF NOT EXISTS, Datenübernahme nur
-- für leere Spalten, Prüfungen nur einmal angelegt).
ALTER TABLE "billing_batches" ADD COLUMN IF NOT EXISTS "remedy_total_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_batches" ADD COLUMN IF NOT EXISTS "copayment_total_cents" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ik" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "legs_code" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "gkv_admission_date" date;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "gkv_contract_note" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "insurer_ik" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "insured_status" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "copayment_exemptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "icd10_second" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "diagnosis_text" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "leitsymptomatik" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "leitsymptomatik_text" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "insurer_ik" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "insurance_number" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "insured_status" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "accident" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "bvg" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "doctor_signed" boolean;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "expired_reason" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "remedy_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "price_snapshot" jsonb;
--> statement-breakpoint
-- Altdaten: IK der Krankenkasse aus patients.extra.payerIk (Pododesk/Tinana-Import) in die neue Spalte übernehmen.
-- Nur gültig aussehende Werte (9 Ziffern); der Schlüssel in extra wird danach entfernt (eine Quelle). Wiederholbar:
-- bereits übernommene Zeilen haben insurer_ik gesetzt und keinen payerIk mehr.
UPDATE patients
   SET insurer_ik = extra->>'payerIk',
       extra = extra - 'payerIk'
 WHERE insurer_ik IS NULL
   AND extra ? 'payerIk'
   AND (extra->>'payerIk') ~ '^[0-9]{9}$';
--> statement-breakpoint
-- gleicher Wert schon in der Spalte (z. B. erneuter Import) → doppelten Schlüssel entfernen
UPDATE patients SET extra = extra - 'payerIk' WHERE extra ? 'payerIk' AND insurer_ik = extra->>'payerIk';
--> statement-breakpoint
-- Versichertenstatus aus dem Pododesk-Import (extra.insuranceStatus, z. B. „1“, „1000000“, „5 Rentner“): nur die
-- eindeutige Versichertenart 1/3/5 an erster Stelle; alles andere bleibt in extra.
UPDATE patients
   SET insured_status = substring(btrim(extra->>'insuranceStatus') from 1 for 1)
 WHERE insured_status IS NULL
   AND btrim(coalesce(extra->>'insuranceStatus', '')) ~ '^[135]([0-9]{0,6})?(\s|$)';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_insured_status_check') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_insured_status_check CHECK (insured_status IS NULL OR insured_status IN ('1', '3', '5'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_insured_status_check') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_insured_status_check CHECK (insured_status IS NULL OR insured_status IN ('1', '3', '5'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_insurer_ik_check') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_insurer_ik_check CHECK (insurer_ik IS NULL OR insurer_ik ~ '^[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_insurer_ik_check') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_insurer_ik_check CHECK (insurer_ik IS NULL OR insurer_ik ~ '^[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_ik_check') THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_ik_check CHECK (ik IS NULL OR ik ~ '^[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_copayment_exemptions_check') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_copayment_exemptions_check CHECK (jsonb_typeof(copayment_exemptions) = 'array');
  END IF;
END $$;
