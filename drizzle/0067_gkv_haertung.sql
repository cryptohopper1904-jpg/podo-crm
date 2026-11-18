-- GKV-Härtung (AppSec/Code-Review Paket C, AppSec-Runde 2 zu PR #122):
-- 1. Abrechnungslauf = Summe seiner Verordnungen. Ein Lauf kann Verordnungen nur im Vorgang aufnehmen, in dem er angelegt
--    wurde (0066: Lauf an einer Verordnung nur mit created_at = now() und nicht übergeben; Beträge abgerechneter
--    Verordnungen unveränderlich). Deshalb wird genau dort geprüft – beim Commit (CONSTRAINT TRIGGER, DEFERRABLE
--    INITIALLY DEFERRED), und zwar sowohl beim Anlegen des Laufs (billing_batches) als auch bei JEDER Änderung einer
--    Verordnung mit diesem Lauf (prescriptions: INSERT bzw. UPDATE von Status, Lauf, Beträgen). Ein vorgezogenes
--    `SET CONSTRAINTS … IMMEDIATE` hilft so nicht: jede weitere Verordnung im Lauf löst die Prüfung erneut aus (AppSec K1).
--    Geprüft wird nur ein Lauf mit created_at = now() (im laufenden Vorgang angelegt): Altläufe vor 0067 und spätere
--    Korrekturwege (abgerechnet → Korrektur nötig → abrechnungsreif, Neuabrechnung in einem NEUEN Lauf) bleiben unberührt.
--    Regeln (wie createBillingBatch, src/server/prescriptions.ts): mindestens eine Verordnung; alle Verordnungen mit dem
--    Lauf stehen auf „abgerechnet“ oder „Korrektur nötig“ (letztere bleibt Teil des Laufs – Stand der Erstabrechnung,
--    Export führt sie –, daher zählt sie mit); prescription_count = Anzahl, total_cents = copayment_total_cents =
--    Summe copayment_cents, remedy_total_cents = Summe remedy_cost_cents (fehlende Beträge 0, Spalten nie NULL).
-- 2. Abgerechnete Verordnungen (billed_at oder Lauf gesetzt) sind nicht löschbar – außer im Löschlauf der Person.
-- 3. Löschfreigabe (AppSec K2): podo_owner_delete_allowed (seit 0019) prüfte nur das Kennzeichen podo.patient_delete und
--    current_user = Tabelleneigentümer – das Kennzeichen kann aber jede Sitzung setzen, und FK-Kaskaden laufen als
--    Eigentümer. Jetzt gilt die Freigabe nur, wenn podo_delete_patient sie in der laufenden Transaktion in
--    podo_private.delete_grants eingetragen hat (Schema ohne Rechte für die App-Rolle). Gilt für alle Lösch-Guards mit
--    diesem Muster (Einwilligungen/Medien 0019, 0065, 0066, Verordnungen 0067). Zusätzlich entzieht scripts/migrate.ts der
--    App-Rolle DELETE auf patients und organizations.
-- 4. podo_delete_patient sperrt die Verordnungen der Person vor der Prüfung (FOR UPDATE): eine gleichzeitige Abrechnung
--    wird abgewartet und dann als Aufbewahrungsgrund gesehen.
-- Alle Funktionen mit festem search_path, REVOKE ALL FROM PUBLIC (EXECUTE für die App-Rolle in scripts/migrate.ts).
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
CREATE INDEX IF NOT EXISTS "prescriptions_billing_batch_id" ON "prescriptions" USING btree ("billing_batch_id") WHERE "prescriptions"."billing_batch_id" is not null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_billing_batch_sum_check() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ids uuid[];
  b record;
  n bigint;
  foreign_status bigint;
  copay bigint;
  remedy bigint;
BEGIN
  IF TG_TABLE_NAME = 'billing_batches' THEN
    ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'UPDATE' THEN
    ids := ARRAY[NEW.billing_batch_id, OLD.billing_batch_id];
  ELSE
    ids := ARRAY[NEW.billing_batch_id];
  END IF;
  -- nur Läufe, die in diesem Vorgang angelegt wurden (Anlagezeitpunkt setzt der Server: billing_batches_guard)
  FOR b IN SELECT bb.id, bb.organization_id, bb.prescription_count, bb.total_cents, bb.copayment_total_cents, bb.remedy_total_cents
             FROM billing_batches bb WHERE bb.id = ANY (ids) AND bb.created_at = now()
  LOOP
    SELECT count(*) FILTER (WHERE p.status IN ('billed', 'correction_needed')),
           count(*) FILTER (WHERE p.status NOT IN ('billed', 'correction_needed')),
           coalesce(sum(coalesce(p.copayment_cents, 0)) FILTER (WHERE p.status IN ('billed', 'correction_needed')), 0),
           coalesce(sum(coalesce(p.remedy_cost_cents, 0)) FILTER (WHERE p.status IN ('billed', 'correction_needed')), 0)
      INTO n, foreign_status, copay, remedy
      FROM prescriptions p
     WHERE p.billing_batch_id = b.id AND p.organization_id = b.organization_id;
    IF n = 0 OR foreign_status > 0 OR b.prescription_count IS DISTINCT FROM n
       OR b.total_cents IS DISTINCT FROM copay OR b.copayment_total_cents IS DISTINCT FROM copay
       OR b.remedy_total_cents IS DISTINCT FROM remedy THEN
      RAISE EXCEPTION 'Abrechnungslauf passt nicht zu den abgerechneten Verordnungen (Anzahl %/%, andere Status %, Zuzahlungen %/%, Heilmittelkosten %/%).',
        b.prescription_count, n, foreign_status, b.copayment_total_cents, copay, b.remedy_total_cents, remedy
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
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
DROP TRIGGER IF EXISTS prescriptions_batch_sum_check_insert ON prescriptions;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER prescriptions_batch_sum_check_insert AFTER INSERT ON prescriptions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.billing_batch_id IS NOT NULL)
  EXECUTE FUNCTION podo_billing_batch_sum_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_batch_sum_check_update ON prescriptions;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER prescriptions_batch_sum_check_update
  AFTER UPDATE OF status, billing_batch_id, copayment_cents, remedy_cost_cents ON prescriptions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.billing_batch_id IS NOT NULL OR OLD.billing_batch_id IS NOT NULL)
  EXECUTE FUNCTION podo_billing_batch_sum_check();
--> statement-breakpoint
-- Löschfreigabe der Person: nur podo_delete_patient (SECURITY DEFINER, Eigentümer) trägt ein; die App-Rolle hat auf das
-- Schema keine Rechte (auch nicht über das GRANT auf alle Tabellen in public, scripts/migrate.ts)
CREATE SCHEMA IF NOT EXISTS podo_private;
--> statement-breakpoint
REVOKE ALL ON SCHEMA podo_private FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS podo_private.delete_grants (
	txid bigint NOT NULL,
	patient_id uuid NOT NULL,
	PRIMARY KEY (txid, patient_id)
);
--> statement-breakpoint
REVOKE ALL ON podo_private.delete_grants FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE podo_private.delete_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
COMMENT ON TABLE podo_private.delete_grants IS
  'Löschfreigabe einer Person für die laufende Transaktion – nur podo_delete_patient schreibt (Migration 0067, AppSec K2).';
--> statement-breakpoint
-- Freigabe nur als Tabelleneigentümer (FK-Kaskade bzw. podo_delete_patient) UND mit Eintrag aus podo_delete_patient in
-- dieser Transaktion. Liefert nie NULL. Reihenfolge wichtig: die Tabelle liest nur der Eigentümer (App-Rolle → false).
CREATE OR REPLACE FUNCTION podo_owner_delete_allowed(rel oid, patient uuid) RETURNS boolean LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF patient IS NULL OR current_setting('podo.patient_delete', true) IS DISTINCT FROM patient::text THEN
    RETURN false;
  END IF;
  IF current_user IS DISTINCT FROM (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = rel) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM podo_private.delete_grants g WHERE g.txid = txid_current() AND g.patient_id = patient);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_owner_delete_allowed(oid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_prescription_delete_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
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
-- podo_delete_patient (zuletzt 0066): Verordnungen der Person zuerst sperren (gleichzeitige Abrechnung abwarten), Lauf auch
-- ohne billed_at als Aufbewahrungsgrund, Löschfreigabe in podo_private.delete_grants (am Ende wieder entfernt). Sonst
-- unverändert; fester search_path, Rechte wie 0062.
CREATE OR REPLACE FUNCTION podo_delete_patient(p_patient uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  n int;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'Kein Praxis-Kontext.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM prescriptions WHERE organization_id = org AND patient_id = p_patient FOR UPDATE;
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
  INSERT INTO podo_private.delete_grants (txid, patient_id) VALUES (txid_current(), p_patient) ON CONFLICT DO NOTHING;
  PERFORM set_config('podo.patient_delete', p_patient::text, true);
  DELETE FROM appointments WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM messages WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM voice_calls WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM media WHERE patient_id = p_patient AND organization_id = org;
  DELETE FROM patients WHERE id = p_patient AND organization_id = org;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('podo.patient_delete', '', true);
  DELETE FROM podo_private.delete_grants WHERE txid = txid_current() AND patient_id = p_patient;
  RETURN n = 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_delete_patient(uuid) FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TRIGGER billing_batches_sum_check ON billing_batches IS
  'Anzahl/Summen eines im Vorgang angelegten Abrechnungslaufs = seine Verordnungen (Prüfung beim Commit, Migration 0067).';
