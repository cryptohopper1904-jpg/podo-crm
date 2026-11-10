-- Vertrieb (Plattform-Betreiber): Leads sind keine Mandantendaten → keine RLS-Mandantenregel (wie sessions/password_resets).
-- Zugriff nur über die App-Rolle (Grants aus scripts/migrate.ts); PUBLIC bekommt ausdrücklich nichts.
-- Zweite Sicherung neben der App-Prüfung: gültige Status/Schritte, eine Einstellungszeile, kleingeschriebene Sperrliste.
REVOKE ALL ON sales_leads, sales_sends, sales_suppressions, sales_settings FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_status_check
  CHECK (status IN ('neu', 'in_sequenz', 'geantwortet', 'interessiert', 'kein_interesse', 'abgemeldet', 'kunde'));
--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_step_check CHECK (step BETWEEN 0 AND 3);
--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_name_check CHECK (length(btrim(name)) > 0);
--> statement-breakpoint
ALTER TABLE sales_sends ADD CONSTRAINT sales_sends_step_check CHECK (step BETWEEN 1 AND 3);
--> statement-breakpoint
ALTER TABLE sales_suppressions ADD CONSTRAINT sales_suppressions_email_check CHECK (email = lower(btrim(email)) AND length(email) > 3);
--> statement-breakpoint
ALTER TABLE sales_settings ADD CONSTRAINT sales_settings_single_row CHECK (id = 1);
--> statement-breakpoint
ALTER TABLE sales_settings ADD CONSTRAINT sales_settings_delays_check CHECK (delay2_days BETWEEN 1 AND 60 AND delay3_days BETWEEN 1 AND 60);
--> statement-breakpoint
-- Eine abgemeldete Adresse kann nicht wieder in die Sequenz geraten: Status „abgemeldet“ ist endgültig für den Versand.
CREATE OR REPLACE FUNCTION podo_sales_lead_suppressed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.status NOT IN ('abgemeldet', 'kunde')
     AND EXISTS (SELECT 1 FROM sales_suppressions s WHERE s.email = lower(btrim(NEW.email))) THEN
    NEW.status := 'abgemeldet';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_leads_suppressed BEFORE INSERT OR UPDATE OF email, status ON sales_leads
  FOR EACH ROW EXECUTE FUNCTION podo_sales_lead_suppressed_guard();
