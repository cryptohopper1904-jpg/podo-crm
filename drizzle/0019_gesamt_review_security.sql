-- Gesamt-Review (docs/reviews/GESAMT-REVIEW.md) – H3, H4, H7, Passwort vergessen
-- H4/H7: Status der bestehenden Webhook-Ereignisse übernehmen; verarbeitete Rohdaten löschen (Datenminimierung)
UPDATE webhook_events SET status = CASE
    WHEN processed_at IS NOT NULL THEN 'done'
    WHEN error IS NOT NULL THEN 'failed'
    ELSE 'pending' END;
--> statement-breakpoint
UPDATE webhook_events SET payload = NULL WHERE status = 'done';
--> statement-breakpoint
-- H4: Mandantentrennung auch für Webhook-Ereignisse (der Webhook-Pfad kennt die Praxis)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON webhook_events
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- H3: Kund:in vollständig löschen – nur wenn KEINE aufbewahrungspflichtigen Daten existieren
-- (Behandlungsdokumentation/Anamnese § 630f BGB, Rechnungen § 147 AO / § 14b UStG, Fotos zu Behandlungen).
-- Einwilligungen (append-only) und Medien ohne Behandlungsbezug dürfen dabei mitgelöscht werden – aber nur innerhalb
-- dieser Funktion: das Kennzeichen podo.patient_delete wirkt nur, wenn die Anweisung als Tabelleneigentümer läuft
-- (SECURITY DEFINER). Die App-Rolle kann das Kennzeichen zwar setzen, bleibt aber an die Trigger gebunden.
CREATE OR REPLACE FUNCTION podo_owner_delete_allowed(rel oid, patient uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT patient IS NOT NULL
     AND current_setting('podo.patient_delete', true) = patient::text
     AND current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = rel)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- verschachtelt: OLD.patient_id gibt es nur bei consents (Funktion dient auch audit_log, anamneses, …)
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'consents' THEN
    IF podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Medizinische Dokumentation ist unveränderbar (%). Bitte einen Nachtrag anlegen.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.record_id IS NULL AND podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Medien werden nicht gelöscht, nur als gelöscht markiert.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.taken_at IS DISTINCT FROM OLD.taken_at
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION 'Metadaten von Medien sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.record_id IS NOT NULL AND NEW.record_id IS DISTINCT FROM OLD.record_id THEN
    RAISE EXCEPTION 'Zuordnung zu einem Behandlungseintrag ist unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_delete_patient(p_patient uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  n int;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'Kein Praxis-Kontext.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM treatment_records WHERE patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM anamneses WHERE patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM invoices WHERE patient_id = p_patient)
     OR EXISTS (SELECT 1 FROM media WHERE patient_id = p_patient AND record_id IS NOT NULL) THEN
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
