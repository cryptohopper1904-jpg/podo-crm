-- Zweite Härtung nach externem Review (Grok)

-- 1) TRUNCATE umgeht Zeilen-Trigger → zusätzlich Statement-Trigger
CREATE OR REPLACE FUNCTION podo_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE ist für % verboten (Aufbewahrungspflicht).', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treatment_records','record_addenda','anamneses','consents','audit_log','media','invoices','invoice_lines','payments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- 2) Rechnungen: Notizen ausgestellter Belege ebenfalls fest
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
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.cancels_invoice_id IS DISTINCT FROM OLD.cancels_invoice_id THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (Storno/Gutschrift verwenden).' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'Stornierte Rechnungen können nicht reaktiviert werden.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 3) Positions-Trigger: „fail closed“ (unsichtbare/fehlende Rechnung = Fehler), prüft alte UND neue Rechnung
CREATE OR REPLACE FUNCTION podo_invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE st text; num text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status, number INTO st, num FROM invoices WHERE id = OLD.invoice_id FOR UPDATE;
    IF NOT FOUND OR st <> 'draft' OR num IS NOT NULL THEN
      RAISE EXCEPTION 'Positionen ausgestellter Rechnungen sind unveränderbar.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status, number INTO st, num FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
    IF NOT FOUND OR st <> 'draft' OR num IS NOT NULL THEN
      RAISE EXCEPTION 'Positionen ausgestellter Rechnungen sind unveränderbar.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 4) Hash-Kette kann nicht verzweigen: je Patient höchstens ein Nachfolger pro Vorgänger
CREATE UNIQUE INDEX treatment_records_chain ON treatment_records (organization_id, patient_id, prev_hash) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE UNIQUE INDEX record_addenda_chain ON record_addenda (organization_id, record_id, prev_hash) NULLS NOT DISTINCT;
