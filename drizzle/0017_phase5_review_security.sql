-- Phase 5 (Review-Umsetzung, docs/reviews/code/phase5-umsetzung.md)
-- 1) Mandantentrennung + Unveränderbarkeit der neuen Fiskal-Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_transactions','cash_closing_registrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION podo_forbid_fiscal_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- TSE-Signatur nur zu einer Zahlung derselben Praxis
CREATE OR REPLACE FUNCTION podo_fiscal_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'TSE-Signatur gehört zu keiner Zahlung dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fiscal_transactions_guard BEFORE INSERT ON fiscal_transactions
  FOR EACH ROW EXECUTE FUNCTION podo_fiscal_tx_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_closing_registration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cash_closings c WHERE c.id = NEW.cash_closing_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Kassenabschluss gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cash_closing_registrations_guard BEFORE INSERT ON cash_closing_registrations
  FOR EACH ROW EXECUTE FUNCTION podo_closing_registration_guard();
--> statement-breakpoint
-- 2) Zahlungen: gesperrt ist alles, was zeitlich in einem Abschluss liegt (paid_at <= closed_at) oder an/vor einem
--    abgeschlossenen Buchungstag – nicht nur exakt am abgeschlossenen Tag. Neue Zahlungen von Benutzer:innen dürfen
--    nicht rückwirkend in einen abgeschlossenen Zeitraum datiert werden; verspätete Provider-Zahlungen (Webhook,
--    created_by NULL) und der Altdaten-Import (external_ref 'excel:…') bleiben möglich und gehen in den nächsten Abschluss.
CREATE OR REPLACE FUNCTION podo_payment_in_closed_period(p_org uuid, p_at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM cash_closings c
     WHERE c.organization_id = p_org
       AND (c.closed_at >= p_at OR c.business_date >= (p_at AT TIME ZONE 'Europe/Berlin')::date))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_payment_closing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean; c_org uuid; c_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_closing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Zahlungen dürfen keinem Kassenabschluss zugeordnet sein.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.created_by IS NOT NULL AND COALESCE(NEW.external_ref, '') NOT LIKE 'excel:%' AND EXISTS (
      SELECT 1 FROM cash_closings c WHERE c.organization_id = NEW.organization_id AND c.closed_at >= NEW.paid_at) THEN
      RAISE EXCEPTION 'Zahlungen können nicht rückwirkend in einen abgeschlossenen Kassenzeitraum gebucht werden.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  locked := OLD.cash_closing_id IS NOT NULL OR podo_payment_in_closed_period(OLD.organization_id, OLD.paid_at);
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
  IF locked OR podo_payment_in_closed_period(NEW.organization_id, NEW.paid_at) THEN
    RAISE EXCEPTION 'Zahlungen eines abgeschlossenen Kassentags sind unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 3) Kassenbuch: Einträge nicht rückdatiert (vor den letzten Abschluss) und nicht in der Zukunft
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
    IF NEW.occurred_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Kassenbuch-Einträge dürfen nicht in der Zukunft liegen.' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM cash_closings c WHERE c.organization_id = NEW.organization_id AND c.closed_at >= NEW.occurred_at) THEN
      RAISE EXCEPTION 'Kassenbuch-Einträge können nicht rückwirkend in einen abgeschlossenen Zeitraum gebucht werden.' USING ERRCODE = 'P0001';
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
-- Datenübernahme als Tabelleneigentümer: FORCE RLS gilt auch für den Eigentümer (ohne app.org_id würden die UPDATEs
-- stillschweigend nichts ändern) → für die Dauer dieser Transaktion aussetzen, am Ende wieder einschalten.
ALTER TABLE appointments NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE waitlist NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reminder_log NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 4) Datenübernahme: Portal-Buchungen und Nachrücker bekommen die Quelle „portal“ (bisher „online“ + external_id)
UPDATE appointments SET source = 'portal'
 WHERE source = 'online' AND (external_id LIKE 'portal:%' OR external_id LIKE 'waitlist:%');
--> statement-breakpoint
-- 5) Wartelisten-Wünsche: JSON im Freitext ({"v":1,…}) → Spalten; Freitext-Altbestand bleibt in „wishes“
DO $$
DECLARE r record; j jsonb;
BEGIN
  FOR r IN SELECT id, wishes FROM waitlist WHERE btrim(coalesce(wishes, '')) LIKE '{%' LOOP
    BEGIN
      j := r.wishes::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF jsonb_typeof(j) <> 'object' THEN CONTINUE; END IF;
    UPDATE waitlist SET
      service_ids = coalesce(ARRAY(
        SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j->'serviceIds') = 'array' THEN j->'serviceIds' ELSE '[]'::jsonb END) x
         WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'),
      weekdays = coalesce(ARRAY(
        SELECT DISTINCT x::smallint FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j->'weekdays') = 'array' THEN j->'weekdays' ELSE '[]'::jsonb END) x
         WHERE x ~ '^[1-7]$' ORDER BY 1), '{}'),
      dayparts = coalesce(ARRAY(
        SELECT DISTINCT x FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j->'dayparts') = 'array' THEN j->'dayparts' ELSE '[]'::jsonb END) x
         WHERE x IN ('morning', 'afternoon', 'evening')), '{}'),
      note = CASE WHEN jsonb_typeof(j->'note') = 'string' AND btrim(j->>'note') <> '' THEN left(j->>'note', 500) END,
      wishes = NULL
     WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
-- 6) Wartelisten-Angebot → freier Termin direkt am Link (bisher nur über reminder_log.dedupe_key 'wloffer:<link-id>')
UPDATE patient_links l SET appointment_id = rl.appointment_id
  FROM reminder_log rl
 WHERE l.purpose = 'waitlist_offer' AND l.appointment_id IS NULL
   AND rl.organization_id = l.organization_id AND rl.kind = 'waitlist_offer'
   AND rl.dedupe_key = 'wloffer:' || l.id::text AND rl.appointment_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE waitlist FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reminder_log FORCE ROW LEVEL SECURITY;
