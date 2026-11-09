-- Rechnung aus dem Termin / Anzahlungs-Quittung für die Sammelrechnung: zweite Sicherung neben App-Prüfung und RLS.
-- Hinweis: Der neue Enum-Wert 'deposit' (0025) wird hier nur als Text verglichen (::text) und erst zur Laufzeit
-- ausgewertet – nie im selben Migrationslauf benutzt.

-- 1) Anrechnung einer Anzahlung (invoices.collective_invoice_id): nur Anzahlungen, nur auf eine ausgestellte Rechnung
--    derselben Praxis und derselben Person, und nur einmal. Neu anrechnen nur, wenn die bisherige Rechnung storniert ist.
CREATE OR REPLACE FUNCTION podo_invoice_deposit_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_org uuid;
  t_patient uuid;
  t_status text;
  t_kind text;
  old_status text;
BEGIN
  IF NEW.collective_invoice_id IS NOT DISTINCT FROM OLD.collective_invoice_id THEN
    RETURN NEW;
  END IF;
  IF NEW.kind::text <> 'deposit' THEN
    RAISE EXCEPTION 'Nur Anzahlungen können auf eine Rechnung angerechnet werden.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.collective_invoice_id IS NOT NULL THEN
    SELECT status::text INTO old_status FROM invoices WHERE id = OLD.collective_invoice_id;
    IF old_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Die Anzahlung ist bereits auf eine Rechnung angerechnet.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.collective_invoice_id IS NOT NULL THEN
    IF NEW.status::text = 'cancelled' THEN
      RAISE EXCEPTION 'Eine stornierte Anzahlung kann nicht angerechnet werden.' USING ERRCODE = 'P0001';
    END IF;
    SELECT organization_id, patient_id, status::text, kind::text INTO t_org, t_patient, t_status, t_kind
      FROM invoices WHERE id = NEW.collective_invoice_id;
    IF t_org IS NULL OR t_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Rechnung für die Anrechnung nicht gefunden.' USING ERRCODE = 'P0001';
    END IF;
    IF t_kind NOT IN ('invoice', 'collective') OR t_status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Anzahlungen können nur auf eine ausgestellte Rechnung oder Sammelrechnung angerechnet werden.' USING ERRCODE = 'P0001';
    END IF;
    IF t_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Die Anzahlung gehört zu einer anderen Person.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_deposit_link BEFORE UPDATE OF collective_invoice_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION podo_invoice_deposit_link_guard();
--> statement-breakpoint
-- 2) Terminbezug einer Rechnungsposition nur zu einem Termin derselben Praxis (FK-Prüfungen umgehen RLS)
CREATE OR REPLACE FUNCTION podo_invoice_line_appointment_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.appointment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = NEW.appointment_id AND a.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Termin gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_appointment_org BEFORE INSERT OR UPDATE OF appointment_id, organization_id ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION podo_invoice_line_appointment_org();
