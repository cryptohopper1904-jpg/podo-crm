-- Aktionscodes und Kampagnen (Plattform-Betreiber): plattformweite Tabellen wie sales_* (0028) – keine RLS-Mandantenregel,
-- Zugriff nur über die App-Rolle (Grants aus scripts/migrate.ts) und nur über src/server/promo-codes.ts bzw. vertrieb.ts.
-- Idempotent (mehrfach ausführbar): CHECKs nur, wenn sie fehlen; Trigger werden vorher entfernt.
-- PUBLIC bekommt ausdrücklich nichts. Zweite Sicherung neben der App-Prüfung: Formate, Bereiche, Einlöse-Regeln per Trigger.
REVOKE ALL ON promo_codes, promo_redemptions, sales_campaigns, sales_lead_events FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_code_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$');
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_label_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 120);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_trial_days_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_trial_days_check CHECK (trial_days BETWEEN 1 AND 365);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_grant_plan_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_grant_plan_check CHECK (grant_plan IS NULL OR grant_plan IN ('starter', 'praxis', 'plus'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_max_redemptions_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_max_redemptions_check CHECK (max_redemptions IS NULL OR max_redemptions > 0);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_redemptions_via_check') THEN
    ALTER TABLE promo_redemptions ADD CONSTRAINT promo_redemptions_via_check CHECK (via IN ('signup', 'abo'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_campaigns_name_check') THEN
    ALTER TABLE sales_campaigns ADD CONSTRAINT sales_campaigns_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_lead_events_kind_check') THEN
    ALTER TABLE sales_lead_events ADD CONSTRAINT sales_lead_events_kind_check CHECK (kind IN ('note', 'status', 'reply', 'campaign'));
  END IF;
END $$;
--> statement-breakpoint
-- Code-Stammdaten bleiben fest: Code, Testtage und Tarif ändern sich nach dem Anlegen nicht (änderbar: aktiv, Bezeichnung, Grenzen, Kampagne).
CREATE OR REPLACE FUNCTION podo_promo_code_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.trial_days IS DISTINCT FROM OLD.trial_days OR NEW.grant_plan IS DISTINCT FROM OLD.grant_plan THEN
    RAISE EXCEPTION 'Aktionscode: Code, Testtage und Tarif sind nach dem Anlegen unveränderbar';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS promo_codes_immutable ON promo_codes;
--> statement-breakpoint
CREATE TRIGGER promo_codes_immutable BEFORE UPDATE ON promo_codes FOR EACH ROW EXECUTE FUNCTION podo_promo_code_immutable();
--> statement-breakpoint
-- Einlösen: Code-Zeile sperren (parallele Einlösungen warten aufeinander), dann aktiv/gültig/Obergrenze prüfen.
-- Die App prüft dasselbe vorher; dieser Trigger ist die Sicherung gegen Rennen und Fehlgriffe.
CREATE OR REPLACE FUNCTION podo_promo_redemption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c promo_codes%ROWTYPE;
  used integer;
BEGIN
  SELECT * INTO c FROM promo_codes WHERE id = NEW.code_id FOR UPDATE;
  IF NOT FOUND OR NOT c.active OR (c.valid_until IS NOT NULL AND c.valid_until <= now()) THEN
    RAISE EXCEPTION 'promo_code_unavailable';
  END IF;
  IF c.max_redemptions IS NOT NULL THEN
    SELECT count(*) INTO used FROM promo_redemptions WHERE code_id = NEW.code_id;
    IF used >= c.max_redemptions THEN
      RAISE EXCEPTION 'promo_code_unavailable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS promo_redemptions_guard ON promo_redemptions;
--> statement-breakpoint
CREATE TRIGGER promo_redemptions_guard BEFORE INSERT ON promo_redemptions FOR EACH ROW EXECUTE FUNCTION podo_promo_redemption_guard();
--> statement-breakpoint
-- Einlösungen sind ein Nachweis (wer, wann, welche Testphase): nicht änderbar. Löschen nur mit der Praxis (Kaskade/Löschlauf).
CREATE OR REPLACE FUNCTION podo_promo_redemption_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Einlösungen von Aktionscodes sind unveränderbar';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS promo_redemptions_no_update ON promo_redemptions;
--> statement-breakpoint
CREATE TRIGGER promo_redemptions_no_update BEFORE UPDATE ON promo_redemptions FOR EACH ROW EXECUTE FUNCTION podo_promo_redemption_no_update();
