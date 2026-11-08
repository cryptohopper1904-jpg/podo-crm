-- Phase 5: Kasse (KassenSichV / GoBD)
-- 1) Mandantentrennung für die neuen Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_closings','cash_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_forbid_fiscal_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Kassendaten sind unveränderbar (%, GoBD). Korrektur nur per Gegenbuchung.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
-- 2) Kassenabschlüsse (Z-Bon): nur anhängen, nie ändern/löschen
CREATE TRIGGER cash_closings_no_update BEFORE UPDATE OR DELETE ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_fiscal_change();
--> statement-breakpoint
CREATE TRIGGER cash_closings_no_truncate BEFORE TRUNCATE ON cash_closings
  FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate();
--> statement-breakpoint
-- Lückenlose Z-Nummer, Hash-Kette ohne Verzweigung, Buchungstage nur aufsteigend
CREATE OR REPLACE FUNCTION podo_cash_closing_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_nr integer; last_hash text; last_date date;
BEGIN
  SELECT number, hash, business_date INTO last_nr, last_hash, last_date
    FROM cash_closings WHERE organization_id = NEW.organization_id ORDER BY number DESC LIMIT 1;
  IF NEW.number IS DISTINCT FROM COALESCE(last_nr, 0) + 1 THEN
    RAISE EXCEPTION 'Z-Nummer muss lückenlos fortlaufen (erwartet %).', COALESCE(last_nr, 0) + 1 USING ERRCODE = 'P0001';
  END IF;
  IF NEW.prev_hash IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'Hash-Kette der Kassenabschlüsse unterbrochen.' USING ERRCODE = 'P0001';
  END IF;
  IF last_date IS NOT NULL AND NEW.business_date <= last_date THEN
    RAISE EXCEPTION 'Buchungstag liegt nicht nach dem letzten Abschluss.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cash_closings_sequence BEFORE INSERT ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION podo_cash_closing_sequence();
--> statement-breakpoint
CREATE UNIQUE INDEX cash_closings_chain ON cash_closings (organization_id, prev_hash) NULLS NOT DISTINCT;
--> statement-breakpoint
ALTER TABLE cash_closings ADD CONSTRAINT cash_closings_math_check CHECK (
  number >= 1
  AND expected_cash_cents = opening_cents + cash_payments_cents + movements_cents
  AND difference_cents = counted_cash_cents - expected_cash_cents
  AND counted_cash_cents >= 0
  AND last_bon_nr >= first_bon_nr - 1
);
--> statement-breakpoint
-- 3) Einlagen/Entnahmen: nur anhängen; einzig erlaubte Änderung = Zuordnung zum Abschluss (einmalig)
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check CHECK (
  (kind IN ('private_deposit','transit_in','payin') AND amount_cents > 0)
  OR (kind IN ('private_withdrawal','transit_out','payout') AND amount_cents < 0)
);
--> statement-breakpoint
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_reason_check CHECK (length(btrim(reason)) > 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_cash_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c_org uuid; c_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kassenbuch-Einträge werden nicht gelöscht (Gegenbuchung verwenden).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_closing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Kassenbuch-Einträge dürfen keinem Abschluss zugeordnet sein.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.cash_closing_id IS NOT NULL OR NEW.cash_closing_id IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Kassenbuch-Einträge sind unveränderbar (Gegenbuchung verwenden).' USING ERRCODE = 'P0001';
  END IF;
  SELECT organization_id, closed_at INTO c_org, c_at FROM cash_closings WHERE id = NEW.cash_closing_id;
  IF c_org IS DISTINCT FROM NEW.organization_id OR NEW.occurred_at > c_at THEN
    RAISE EXCEPTION 'Ungültige Zuordnung zum Kassenabschluss.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cash_movements_guard BEFORE INSERT OR UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION podo_cash_movement_guard();
--> statement-breakpoint
CREATE TRIGGER cash_movements_no_truncate BEFORE TRUNCATE ON cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate();
--> statement-breakpoint
-- 4) Zahlungen eines abgeschlossenen Kassentags (oder bereits einem Z-Bon zugeordnet) sind gesperrt.
--    Neue (z. B. verspätete Webhook-)Zahlungen dürfen weiter angelegt werden; sie gehen in den nächsten Abschluss.
CREATE OR REPLACE FUNCTION podo_payment_closing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean; c_org uuid; c_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_closing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Zahlungen dürfen keinem Kassenabschluss zugeordnet sein.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  locked := OLD.cash_closing_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM cash_closings c
     WHERE c.organization_id = OLD.organization_id
       AND c.business_date = (OLD.paid_at AT TIME ZONE 'Europe/Berlin')::date);
  IF TG_OP = 'DELETE' THEN
    IF locked THEN
      RAISE EXCEPTION 'Zahlungen eines abgeschlossenen Kassentags können nicht gelöscht werden.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  -- Einzig erlaubte Änderung an gesperrten Zahlungen: Zuordnung zum Abschluss (NULL → Z-Bon), sonst nichts
  IF NEW.cash_closing_id IS DISTINCT FROM OLD.cash_closing_id THEN
    IF OLD.cash_closing_id IS NOT NULL
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR NEW.voucher_id IS DISTINCT FROM OLD.voucher_id OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'Zahlungen eines abgeschlossenen Kassentags sind unveränderbar.' USING ERRCODE = 'P0001';
    END IF;
    SELECT organization_id, closed_at INTO c_org, c_at FROM cash_closings WHERE id = NEW.cash_closing_id;
    IF c_org IS DISTINCT FROM NEW.organization_id OR NEW.paid_at > c_at THEN
      RAISE EXCEPTION 'Ungültige Zuordnung zum Kassenabschluss.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF locked OR EXISTS (
    SELECT 1 FROM cash_closings c
     WHERE c.organization_id = NEW.organization_id
       AND c.business_date = (NEW.paid_at AT TIME ZONE 'Europe/Berlin')::date) THEN
    RAISE EXCEPTION 'Zahlungen eines abgeschlossenen Kassentags sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_closing_guard BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION podo_payment_closing_guard();
