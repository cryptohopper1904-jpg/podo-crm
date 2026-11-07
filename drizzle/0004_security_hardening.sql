-- Härtung nach externem Security-Review (docs/reviews/code)

-- 1) Rechnungen: einmal ausgestellt (Nummer vergeben) bleibt unveränderbar, kein Zurück auf "draft"
CREATE OR REPLACE FUNCTION podo_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  locked := OLD.status <> 'draft' OR OLD.number IS NOT NULL;
  IF TG_OP = 'DELETE' THEN
    IF locked THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen können nicht gelöscht werden (Storno verwenden).' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF locked THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (kein Zurücksetzen auf Entwurf).' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.net_cents IS DISTINCT FROM OLD.net_cents OR NEW.vat_cents IS DISTINCT FROM OLD.vat_cents
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.billing_contact_id IS DISTINCT FROM OLD.billing_contact_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (Storno/Gutschrift verwenden).' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; num text;
BEGIN
  SELECT status, number INTO st, num FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF (st IS NOT NULL AND st <> 'draft') OR num IS NOT NULL THEN
    RAISE EXCEPTION 'Positionen ausgestellter Rechnungen sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'Positionen können nicht umgehängt werden.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 2) Medien: NULL-sichere Vergleiche
CREATE OR REPLACE FUNCTION podo_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
-- 3) Audit-Log: Lesen nur im eigenen Mandanten; Schreiben immer erlaubt (auch für Login-Ereignisse ohne Mandant)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY audit_select ON audit_log FOR SELECT USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
