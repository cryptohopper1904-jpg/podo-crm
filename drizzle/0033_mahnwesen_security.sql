-- Mahnwesen: Mandantentrennung (RLS + FORCE), Wertebereiche, Unveränderbarkeit und Prüfung der Rechnung.
ALTER TABLE invoice_dunnings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_dunnings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_dunnings
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE invoice_dunnings ADD CONSTRAINT invoice_dunnings_stage_check CHECK (stage IN ('reminder', 'dunning1', 'dunning2'));
--> statement-breakpoint
ALTER TABLE invoice_dunnings ADD CONSTRAINT invoice_dunnings_sent_via_check CHECK (sent_via IS NULL OR sent_via IN ('email', 'post'));
--> statement-breakpoint
-- Gebühren nur als konkrete Kosten (Obergrenze 25 €); die verzugsbegründende Zahlungserinnerung ist immer kostenlos
ALTER TABLE invoice_dunnings ADD CONSTRAINT invoice_dunnings_amounts_check CHECK (
  open_cents > 0 AND fee_cents >= 0 AND fee_cents <= 2500 AND fees_total_cents >= fee_cents
  AND (stage <> 'reminder' OR fee_cents = 0) AND pay_by >= letter_date);
--> statement-breakpoint
-- Neue Mahnung nur zu einer offenen Rechnung derselben Praxis (keine Quittung/Anzahlung/Storno, nicht bezahlt/storniert)
-- und nur in der Reihenfolge Zahlungserinnerung → 1. Mahnung → 2. Mahnung. FK-Prüfungen umgehen RLS, daher hier explizit.
CREATE OR REPLACE FUNCTION podo_invoice_dunning_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_org uuid;
  t_kind text;
  t_status text;
  prev text;
BEGIN
  SELECT organization_id, kind::text, status::text INTO t_org, t_kind, t_status FROM invoices WHERE id = NEW.invoice_id;
  IF t_org IS NULL OR t_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'Rechnung für die Mahnung nicht gefunden.' USING ERRCODE = 'P0001';
  END IF;
  IF t_kind NOT IN ('invoice', 'collective', 'no_show_fee') THEN
    RAISE EXCEPTION 'Quittungen, Anzahlungen und Stornorechnungen werden nicht gemahnt.' USING ERRCODE = 'P0001';
  END IF;
  IF t_status NOT IN ('issued', 'partially_paid') THEN
    RAISE EXCEPTION 'Nur offene Rechnungen können gemahnt werden.' USING ERRCODE = 'P0001';
  END IF;
  prev := CASE NEW.stage WHEN 'dunning1' THEN 'reminder' WHEN 'dunning2' THEN 'dunning1' ELSE NULL END;
  IF prev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice_dunnings d WHERE d.invoice_id = NEW.invoice_id AND d.stage = prev) THEN
    RAISE EXCEPTION 'Mahnstufen nur der Reihe nach (Zahlungserinnerung → 1. Mahnung → 2. Mahnung).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_dunnings_insert_guard BEFORE INSERT ON invoice_dunnings
  FOR EACH ROW EXECUTE FUNCTION podo_invoice_dunning_insert_guard();
--> statement-breakpoint
-- Erstellte Mahnungen sind unveränderbar; nur der Versandvermerk (sent_via/sent_at/sent_to) darf gesetzt werden.
CREATE OR REPLACE FUNCTION podo_invoice_dunning_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mahnungen sind unveränderbar und können nicht gelöscht werden.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.stage <> OLD.stage OR NEW.letter_date <> OLD.letter_date OR NEW.pay_by <> OLD.pay_by
     OR NEW.open_cents <> OLD.open_cents OR NEW.fee_cents <> OLD.fee_cents OR NEW.fees_total_cents <> OLD.fees_total_cents
     OR NEW.body <> OLD.body OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Mahnungen sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_dunnings_guard BEFORE UPDATE OR DELETE ON invoice_dunnings
  FOR EACH ROW EXECUTE FUNCTION podo_invoice_dunning_guard();
