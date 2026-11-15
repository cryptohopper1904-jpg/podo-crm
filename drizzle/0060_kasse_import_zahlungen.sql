-- Buchhaltung K1/BA (PR #104, Übernahme-Assistent): Übernommene Zahlungen aus dem Excel-Rechnungsmanager
-- (payments.external_ref 'excel:…', Groß-/Kleinschreibung egal) kommen NIE in einen Kassenabschluss.
-- Sie stehen im Kassenbuch des bisherigen Systems; ein Z-Bon/DSFinV-K-Export mit ihnen wäre eine Doppelerfassung.
-- Maßgeblich ist die Herkunft der ZAHLUNG, nicht der Rechnung: Ein Neueingang in PodoHero auf eine übernommene
-- Altrechnung (z. B. Barzahlung am Tresen) gehört in die PodoHero-Kasse und damit in den nächsten Z-Bon.
-- Manuelle Referenzen mit „excel:“ lehnt die App ab (src/server/invoices.ts, applyPayments).
-- Korrigiert die Aussage aus 0017 („der Altdaten-Import … geht in den nächsten Abschluss“). Die App filtert sie seit
-- diesem Stand (src/server/kasse.ts, loadItems); der Trigger verhindert zusätzlich jede Zuordnung zu einem Abschluss.
-- Bestehende Abschlüsse, Zuordnungen und die Hash-Kette bleiben unverändert (nur neue Zuordnungen werden geprüft).
-- Idempotent: CREATE OR REPLACE / COMMENT.
CREATE OR REPLACE FUNCTION podo_payment_closing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean; c_org uuid; c_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_closing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Zahlungen dürfen keinem Kassenabschluss zugeordnet sein.' USING ERRCODE = 'P0001';
    END IF;
    -- Rückdatierung: verspätete Provider-Zahlungen (Webhook, created_by NULL) und der Altdaten-Import
    -- (external_ref 'excel:…') bleiben möglich. Import-Zahlungen kommen nie in einen Abschluss (siehe unten).
    IF NEW.created_by IS NOT NULL AND COALESCE(NEW.external_ref, '') NOT ILIKE 'excel:%' AND EXISTS (
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
    -- übernommene Altzahlungen (Import) nie einem Abschluss zuordnen
    IF COALESCE(NEW.external_ref, '') ILIKE 'excel:%' THEN
      RAISE EXCEPTION 'Übernommene Zahlungen (Import) kommen in keinen Kassenabschluss.' USING ERRCODE = 'P0001';
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
COMMENT ON FUNCTION podo_payment_closing_guard() IS
  'Kassensperre für payments: keine Rückdatierung in abgeschlossene Zeiträume (außer Provider-Webhooks und Altdaten-Import excel:…), abgeschlossene Zahlungen unveränderbar. Übernommene Altzahlungen (external_ref excel:…, Herkunft der Zahlung) kommen nie in einen Kassenabschluss; Neueingänge auf übernommene Altrechnungen schon (Migration 0060, korrigiert 0017).';
