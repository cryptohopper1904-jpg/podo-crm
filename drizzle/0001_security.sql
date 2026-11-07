-- PodoCRM Sicherheitsmigration
-- 1) Append-only für medizinische Dokumentation (§ 630f BGB)
-- 2) Row-Level-Security je Mandant (app.org_id), auch für den Tabellen-Eigentümer (FORCE)
-- Hinweis: Superuser umgehen RLS immer – die App muss mit einer Nicht-Superuser-Rolle laufen.

CREATE OR REPLACE FUNCTION podo_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Medizinische Dokumentation ist unveränderbar (%). Bitte einen Nachtrag anlegen.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER treatment_records_no_update BEFORE UPDATE OR DELETE ON treatment_records
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
CREATE TRIGGER record_addenda_no_update BEFORE UPDATE OR DELETE ON record_addenda
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
CREATE TRIGGER anamneses_no_update BEFORE UPDATE OR DELETE ON anamneses
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
CREATE TRIGGER consents_no_update BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
-- Medien dürfen nur „weich“ gelöscht werden (deleted_at), Inhalt/Hash bleiben unverändert
CREATE OR REPLACE FUNCTION podo_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Medien werden nicht gelöscht, nur als gelöscht markiert.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.patient_id <> OLD.patient_id
     OR NEW.taken_at <> OLD.taken_at OR NEW.uploaded_by <> OLD.uploaded_by THEN
    RAISE EXCEPTION 'Metadaten von Medien sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER media_guard BEFORE UPDATE OR DELETE ON media FOR EACH ROW EXECUTE FUNCTION podo_media_guard();
--> statement-breakpoint
-- Ausgestellte Rechnungen: Beträge/Nummer unveränderbar (GoBD) – Korrektur nur über Storno/Gutschrift
CREATE OR REPLACE FUNCTION podo_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Ausgestellte Rechnungen können nicht gelöscht werden (Storno verwenden).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.total_cents <> OLD.total_cents
       OR NEW.net_cents <> OLD.net_cents OR NEW.vat_cents <> OLD.vat_cents
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.patient_id IS DISTINCT FROM OLD.patient_id) THEN
    RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (Storno/Gutschrift verwenden).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION podo_invoice_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Positionen ausgestellter Rechnungen sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION podo_invoice_lines_guard();
--> statement-breakpoint
-- Row-Level-Security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations','billing_contacts','patients','consents','anamneses','services','appointments',
    'appointment_services','waitlist','prescriptions','sterile_batches','treatment_records','record_addenda',
    'brace_episodes','media','number_sequences','invoices','invoice_lines','vouchers','payments','messages',
    'reviews','integration_connections','sync_log','fixed_costs','tasks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
