-- Eigene Praxiskasse (Praxis-Einstellung „Eigene Praxiskasse verwenden“): Kennzeichnung JE ZAHLUNG, in welchem
-- Kassensystem der Kassenvorgang erfasst ist – 'podohero' (PodoHero-Kasse: TSE-Signatur, Zahlungsbeleg, Z-Bon,
-- DSFinV-K) oder 'external' (zertifizierte Kasse der Praxis; PodoHero vermerkt die Zahlung nur an der Rechnung).
-- Maßgeblich für Tagesabschluss und „Zahlungsbeleg fehlt“ ist diese Kennzeichnung, NICHT die aktuelle Einstellung
-- (sonst änderte ein späteres Umschalten rückwirkend, was in den Z-Bon gehört).
--  - Spalte payments.register, NOT NULL DEFAULT 'podohero', CHECK ('podohero','external'); Bestand = 'podohero'
--  - setzt nur der Server beim Buchen (src/server/invoices.ts applyPayments, src/server/webhooks.ts
--    recordProviderPayment); danach unveränderlich (Trigger payments_register_immutable)
--  - podo_payment_closing_guard (zuletzt 0060): Zahlungen der Praxiskasse ('external') nie einem Kassenabschluss
--    zuordnen; bei der Zuordnung darf sich register nicht ändern; Rückdatierung wie beim Import erlaubt (sie kommen
--    nie in einen PodoHero-Abschluss, ein abgeschlossener Zeitraum ändert sich dadurch nicht)
-- Idempotent: ADD COLUMN IF NOT EXISTS / Constraint nur wenn fehlend / CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "register" text DEFAULT 'podohero' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_register_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_register_check CHECK (register IN ('podohero', 'external'));
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_payment_register_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.register IS DISTINCT FROM OLD.register THEN
    RAISE EXCEPTION 'Das Kassensystem einer Zahlung ist unveränderlich.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payments_register_immutable ON payments;
--> statement-breakpoint
CREATE TRIGGER payments_register_immutable BEFORE UPDATE OF register ON payments
  FOR EACH ROW EXECUTE FUNCTION podo_payment_register_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_payment_closing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean; c_org uuid; c_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cash_closing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Zahlungen dürfen keinem Kassenabschluss zugeordnet sein.' USING ERRCODE = 'P0001';
    END IF;
    -- Rückdatierung: verspätete Provider-Zahlungen (Webhook, created_by NULL), der Altdaten-Import
    -- (external_ref 'excel:…') und Vermerke der Praxiskasse (register 'external') bleiben möglich – die beiden
    -- letzten kommen nie in einen PodoHero-Abschluss (siehe unten).
    IF NEW.created_by IS NOT NULL AND COALESCE(NEW.external_ref, '') NOT ILIKE 'excel:%'
       AND NEW.register IS DISTINCT FROM 'external' AND EXISTS (
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.register IS DISTINCT FROM OLD.register THEN
      RAISE EXCEPTION 'Zahlungen eines abgeschlossenen Kassentags sind unveränderbar.' USING ERRCODE = 'P0001';
    END IF;
    -- übernommene Altzahlungen (Import) nie einem Abschluss zuordnen
    IF COALESCE(NEW.external_ref, '') ILIKE 'excel:%' THEN
      RAISE EXCEPTION 'Übernommene Zahlungen (Import) kommen in keinen Kassenabschluss.' USING ERRCODE = 'P0001';
    END IF;
    -- in der Praxiskasse erfasste Zahlungen stehen in deren Z-Bon, nie in einem PodoHero-Abschluss
    IF NEW.register = 'external' THEN
      RAISE EXCEPTION 'Zahlungen der Praxiskasse kommen in keinen PodoHero-Kassenabschluss.' USING ERRCODE = 'P0001';
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
  'Kassensperre für payments: keine Rückdatierung in abgeschlossene Zeiträume (außer Provider-Webhooks, Altdaten-Import excel:… und Zahlungen der Praxiskasse), abgeschlossene Zahlungen unveränderbar. Übernommene Altzahlungen (external_ref excel:…) und Zahlungen der eigenen Praxiskasse (register external) kommen nie in einen PodoHero-Kassenabschluss (Migrationen 0060, 0063).';
--> statement-breakpoint
COMMENT ON COLUMN payments.register IS
  'Kassensystem des Kassenvorgangs: podohero (PodoHero-Kasse, TSE/Z-Bon/Zahlungsbeleg) oder external (eigene Praxiskasse, nur Vermerk). Vom Server gesetzt, unveränderlich (Migration 0063).';
