-- Quittungen als Teilrechnungen → Sammelrechnung als Schlussrechnung.
-- Anrechnung (invoices.collective_invoice_id) jetzt auch für normale Quittungen (kind = receipt) – aber nur bezahlte und
-- nur auf eine ausgestellte Sammelrechnung derselben Praxis und derselben Person, und nur einmal (wie bei Anzahlungen).
-- Neu anrechnen nur, wenn die bisherige Sammelrechnung storniert ist.
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
  IF NEW.kind::text NOT IN ('deposit', 'receipt') THEN
    RAISE EXCEPTION 'Nur Anzahlungen und Quittungen können auf eine Rechnung angerechnet werden.' USING ERRCODE = 'P0001';
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
    IF NEW.kind::text = 'receipt' AND NEW.status::text <> 'paid' THEN
      RAISE EXCEPTION 'Nur vollständig bezahlte Quittungen können angerechnet werden.' USING ERRCODE = 'P0001';
    END IF;
    SELECT organization_id, patient_id, status::text, kind::text INTO t_org, t_patient, t_status, t_kind
      FROM invoices WHERE id = NEW.collective_invoice_id;
    IF t_org IS NULL OR t_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Rechnung für die Anrechnung nicht gefunden.' USING ERRCODE = 'P0001';
    END IF;
    IF t_kind NOT IN ('invoice', 'collective') OR t_status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Anzahlungen können nur auf eine ausgestellte Rechnung oder Sammelrechnung angerechnet werden.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.kind::text = 'receipt' AND t_kind <> 'collective' THEN
      RAISE EXCEPTION 'Quittungen können nur auf eine Sammelrechnung angerechnet werden.' USING ERRCODE = 'P0001';
    END IF;
    IF t_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Die Anzahlung gehört zu einer anderen Person.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
