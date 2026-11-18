-- GKV-Härtung (AppSec/Code-Review Paket C):
-- 1. billing_batches: Anzahl und Summen eines NEUEN Abrechnungslaufs werden beim Commit gegen die darin abgerechneten
--    Verordnungen geprüft (CONSTRAINT TRIGGER AFTER INSERT, DEFERRABLE INITIALLY DEFERRED) – gleiche Berechnung wie
--    createBillingBatch (src/server/prescriptions.ts): prescription_count = Anzahl der Verordnungen mit diesem Lauf und
--    Status „abgerechnet“ (mindestens eine), total_cents = copayment_total_cents = Summe copayment_cents,
--    remedy_total_cents = Summe remedy_cost_cents (fehlende Beträge zählen 0, Spalten nie NULL). Nur INSERT wird geprüft:
--    Altläufe (vor 0067) und die Übergabe (UPDATE exported_at/status) bleiben unberührt. Daten-only-Restore mit aktiven
--    Triggern lehnt Läufe ab, deren Verordnungen nicht in derselben Transaktion folgen (docs/BETRIEB.md).
-- 2. prescriptions: abgerechnete Verordnungen (billed_at oder Lauf gesetzt) sind nicht löschbar – außer im Löschlauf der
--    Person (podo_owner_delete_allowed, Muster 0019/0065/0066), den podo_delete_patient bei abgerechneten Verordnungen
--    ohnehin verweigert. podo_delete_patient zählt jetzt auch eine Verordnung mit Lauf (ohne billed_at) als
--    Aufbewahrungsgrund. Endgültige Löschung der Praxis (purge-organization) schaltet die Trigger ab.
-- Alle Funktionen mit festem search_path, REVOKE ALL FROM PUBLIC. Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
CREATE OR REPLACE FUNCTION podo_billing_batch_sum_check() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n bigint;
  copay bigint;
  remedy bigint;
BEGIN
  SELECT count(*), coalesce(sum(coalesce(p.copayment_cents, 0)), 0), coalesce(sum(coalesce(p.remedy_cost_cents, 0)), 0)
    INTO n, copay, remedy
    FROM prescriptions p
   WHERE p.billing_batch_id = NEW.id AND p.organization_id = NEW.organization_id AND p.status = 'billed';
  IF n = 0 OR NEW.prescription_count IS DISTINCT FROM n
     OR NEW.total_cents IS DISTINCT FROM copay OR NEW.copayment_total_cents IS DISTINCT FROM copay
     OR NEW.remedy_total_cents IS DISTINCT FROM remedy THEN
    RAISE EXCEPTION 'Abrechnungslauf passt nicht zu den abgerechneten Verordnungen (Anzahl %/%, Zuzahlungen %/%, Heilmittelkosten %/%).',
      NEW.prescription_count, n, NEW.copayment_total_cents, copay, NEW.remedy_total_cents, remedy
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_billing_batch_sum_check() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batches_sum_check ON billing_batches;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER billing_batches_sum_check AFTER INSERT ON billing_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION podo_billing_batch_sum_check();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_prescription_delete_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Muster 0066: nur ein ausdrückliches TRUE erlaubt (podo_owner_delete_allowed ist NULL, solange podo.patient_delete in
  -- der Sitzung nie gesetzt wurde – „NOT …“ ließe das Löschen dann durch)
  IF OLD.billed_at IS NULL AND OLD.billing_batch_id IS NULL THEN
    RETURN OLD;
  END IF;
  IF podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Eine abgerechnete Verordnung kann nicht gelöscht werden (Abrechnungsunterlage).' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_prescription_delete_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_delete_guard ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_delete_guard BEFORE DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_prescription_delete_guard();
--> statement-breakpoint
-- podo_delete_patient (zuletzt 0066): zusätzlich Verordnungen mit Abrechnungslauf (auch ohne billed_at) als
-- Aufbewahrungsgrund. Sonst unverändert; fester search_path, Rechte wie 0062.
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
                  AND (billed_at IS NOT NULL OR billing_batch_id IS NOT NULL OR copayment_paid_at IS NOT NULL)) THEN
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
--> statement-breakpoint
COMMENT ON TRIGGER billing_batches_sum_check ON billing_batches IS
  'Anzahl/Summen eines neuen Abrechnungslaufs = abgerechnete Verordnungen des Laufs (Prüfung beim Commit, Migration 0067).';
