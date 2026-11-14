-- Fremdschlüssel nur innerhalb derselben Praxis (AppSec-Befund MITTEL, Termin/Einwilligung mit fremder Patient:in).
--
-- Postgres prüft Fremdschlüssel unabhängig von RLS: Ein Mitglied von Praxis A konnte mit der UUID einer Patient:in
-- (eines Termins, einer Rechnung …) aus Praxis B eine eigene Zeile anlegen, die auf B zeigt. Für die Verweise ohne
-- eigenen Org-Trigger (vorhanden u. a.: calendar_blocks, invoice_lines.appointment_id/product_id, products,
-- stock_movements, payments.cash_closing_id, cash_movements, fiscal_transactions, trip_corrections, invoice_dunnings,
-- document_archive, invoice_credits, payment_receipts, calendar_feed_events.feed_id, invoices.collective_invoice_id)
-- prüft jetzt ein generischer Trigger beim INSERT/UPDATE, dass der Zieldatensatz dieselbe organization_id hat.
--
-- Warum SECURITY DEFINER + lokales app.org_id (und nicht nur SECURITY INVOKER):
--  * Unter RLS sieht die aufrufende Rolle nur Zeilen der Praxis aus app.org_id. Die Prüfung hinge damit vom
--    Sitzungskontext ab (falscher/leerer Kontext → falsches Ergebnis) und von den SELECT-Rechten der Rolle.
--  * SECURITY DEFINER allein genügt nicht: RLS ist erzwungen (FORCE) und gilt auch für den Eigentümer, sobald er kein
--    Superuser ist (Migration mit Nicht-Superuser-Owner). Deshalb setzt die Funktion app.org_id für ihre eigene
--    Abfrage auf die Praxis der NEUEN Zeile und stellt danach den Wert des Aufrufers wieder her. (Eine SET-Klausel
--    `SET app.org_id = ''` an der Funktion wäre eleganter, darf ein Nicht-Superuser für einen Platzhalter-Parameter
--    aber nicht anlegen: „permission denied to set parameter“.) Bricht die Prüfung mit Fehler ab, setzt das Rollback
--    der (Sub-)Transaktion den lokalen Wert ohnehin zurück.
--  * Die Abfrage selbst filtert zusätzlich ausdrücklich auf organization_id (auch für Superuser/BYPASSRLS korrekt)
--    und liest nur (id, organization_id). Fester search_path, Tabellenname per format(%I) aus den Trigger-Argumenten.
--    Trigger-Funktionen lassen sich nicht direkt aufrufen; EXECUTE wird trotzdem PUBLIC entzogen.
--
-- Bestandsdaten: Der Trigger gilt nur für neue Schreibvorgänge (wie NOT VALID). Bei UPDATE wird ein Verweis nur
-- geprüft, wenn er sich ändert (oder die Praxis wechselt) – Altzeilen bleiben bearbeitbar. Inkonsistente Altzeilen
-- werden am Ende als NOTICE gemeldet (scripts/migrate.ts gibt NOTICEs aus), die Migration scheitert daran nicht.
CREATE OR REPLACE FUNCTION podo_fk_same_org() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb;
  i int := 0;
  col text;
  tbl text;
  ref text;
  found boolean;
  label text;
  prev_org text;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW; -- NOT NULL der Spalte greift
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
  END IF;
  prev_org := coalesce(current_setting('app.org_id', true), '');
  -- Zeile für eine andere Praxis als den gesetzten Kontext: ohne Lookup ablehnen. Sonst wäre die Funktion (sie
  -- liest als Eigentümer im Kontext der NEUEN Zeile) ein Orakel „gehört Datensatz X zu Praxis Y?“ – die RLS-Prüfung
  -- (WITH CHECK) läuft erst nach den BEFORE-Triggern. Ohne Kontext (Owner-/Superuser-Wartung) wird normal geprüft.
  IF prev_org <> '' AND prev_org <> NEW.organization_id::text THEN
    RAISE EXCEPTION 'Zeile gehört nicht zur Praxis des aktuellen Kontexts.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- nur für die Abfragen dieser Funktion; Wert des Aufrufers am Ende wiederherstellen
  PERFORM set_config('app.org_id', NEW.organization_id::text, true);
  WHILE i + 1 < TG_NARGS LOOP
    col := TG_ARGV[i];
    tbl := TG_ARGV[i + 1];
    i := i + 2;
    ref := new_row ->> col;
    CONTINUE WHEN ref IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE'
      AND ref IS NOT DISTINCT FROM (old_row ->> col)
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I t WHERE t.id = $1 AND t.organization_id = $2)', tbl)
      INTO found USING ref::uuid, NEW.organization_id;
    IF NOT found THEN
      label := CASE tbl
        WHEN 'patients' THEN 'Patient:in'
        WHEN 'appointments' THEN 'Termin'
        WHEN 'invoices' THEN 'Rechnung'
        WHEN 'treatment_records' THEN 'Dokumentation'
        WHEN 'prescriptions' THEN 'Verordnung'
        WHEN 'services' THEN 'Leistung'
        WHEN 'billing_contacts' THEN 'Rechnungsempfänger:in'
        WHEN 'locations' THEN 'Standort'
        WHEN 'brace_episodes' THEN 'Spangen-Behandlung'
        WHEN 'vouchers' THEN 'Gutschein'
        WHEN 'devices' THEN 'Gerät'
        ELSE 'Verknüpfter Datensatz'
      END;
      RAISE EXCEPTION '% gehört nicht zu dieser Praxis.', label
        USING ERRCODE = 'foreign_key_violation',
              DETAIL = format('%s.%s → %s', TG_TABLE_NAME, col, tbl);
    END IF;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_fk_same_org() FROM PUBLIC;
--> statement-breakpoint
-- Argumente: Paare (Spalte, Zieltabelle). UPDATE OF: nur die Verweise und organization_id.
DROP TRIGGER IF EXISTS appointments_fk_same_org ON appointments;
--> statement-breakpoint
CREATE TRIGGER appointments_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, location_id, organization_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'location_id', 'locations');
--> statement-breakpoint
DROP TRIGGER IF EXISTS appointment_services_fk_same_org ON appointment_services;
--> statement-breakpoint
CREATE TRIGGER appointment_services_fk_same_org BEFORE INSERT OR UPDATE OF appointment_id, service_id, organization_id ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('appointment_id', 'appointments', 'service_id', 'services');
--> statement-breakpoint
DROP TRIGGER IF EXISTS consents_fk_same_org ON consents;
--> statement-breakpoint
CREATE TRIGGER consents_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON consents
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS anamneses_fk_same_org ON anamneses;
--> statement-breakpoint
CREATE TRIGGER anamneses_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON anamneses
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS brace_episodes_fk_same_org ON brace_episodes;
--> statement-breakpoint
CREATE TRIGGER brace_episodes_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON brace_episodes
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fk_same_org ON messages;
--> statement-breakpoint
CREATE TRIGGER messages_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON messages
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_fk_same_org ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_fk_same_org ON tasks;
--> statement-breakpoint
CREATE TRIGGER tasks_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS waitlist_fk_same_org ON waitlist;
--> statement-breakpoint
CREATE TRIGGER waitlist_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, organization_id ON waitlist
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients');
--> statement-breakpoint
DROP TRIGGER IF EXISTS patient_links_fk_same_org ON patient_links;
--> statement-breakpoint
CREATE TRIGGER patient_links_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, appointment_id, organization_id ON patient_links
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'appointment_id', 'appointments');
--> statement-breakpoint
DROP TRIGGER IF EXISTS reminder_log_fk_same_org ON reminder_log;
--> statement-breakpoint
CREATE TRIGGER reminder_log_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, appointment_id, organization_id ON reminder_log
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'appointment_id', 'appointments');
--> statement-breakpoint
DROP TRIGGER IF EXISTS voice_calls_fk_same_org ON voice_calls;
--> statement-breakpoint
CREATE TRIGGER voice_calls_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, appointment_id, organization_id ON voice_calls
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'appointment_id', 'appointments');
--> statement-breakpoint
DROP TRIGGER IF EXISTS calendar_feed_events_fk_same_org ON calendar_feed_events;
--> statement-breakpoint
CREATE TRIGGER calendar_feed_events_fk_same_org BEFORE INSERT OR UPDATE OF appointment_id, organization_id ON calendar_feed_events
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('appointment_id', 'appointments');
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_records_fk_same_org ON treatment_records;
--> statement-breakpoint
CREATE TRIGGER treatment_records_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, appointment_id, prescription_id, organization_id ON treatment_records
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'appointment_id', 'appointments', 'prescription_id', 'prescriptions');
--> statement-breakpoint
DROP TRIGGER IF EXISTS record_addenda_fk_same_org ON record_addenda;
--> statement-breakpoint
CREATE TRIGGER record_addenda_fk_same_org BEFORE INSERT OR UPDATE OF record_id, organization_id ON record_addenda
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('record_id', 'treatment_records');
--> statement-breakpoint
DROP TRIGGER IF EXISTS media_fk_same_org ON media;
--> statement-breakpoint
CREATE TRIGGER media_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, record_id, brace_episode_id, organization_id ON media
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'record_id', 'treatment_records', 'brace_episode_id', 'brace_episodes');
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_fk_same_org ON invoices;
--> statement-breakpoint
CREATE TRIGGER invoices_fk_same_org BEFORE INSERT OR UPDATE OF patient_id, billing_contact_id, organization_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('patient_id', 'patients', 'billing_contact_id', 'billing_contacts');
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_lines_fk_same_org ON invoice_lines;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_fk_same_org BEFORE INSERT OR UPDATE OF invoice_id, service_id, treatment_record_id, organization_id ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('invoice_id', 'invoices', 'service_id', 'services', 'treatment_record_id', 'treatment_records');
--> statement-breakpoint
DROP TRIGGER IF EXISTS patients_fk_same_org ON patients;
--> statement-breakpoint
CREATE TRIGGER patients_fk_same_org BEFORE INSERT OR UPDATE OF care_home_id, billing_contact_id, organization_id ON patients
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('care_home_id', 'billing_contacts', 'billing_contact_id', 'billing_contacts');
--> statement-breakpoint
DROP TRIGGER IF EXISTS payments_fk_same_org ON payments;
--> statement-breakpoint
CREATE TRIGGER payments_fk_same_org BEFORE INSERT OR UPDATE OF invoice_id, voucher_id, organization_id ON payments
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('invoice_id', 'invoices', 'voucher_id', 'vouchers');
--> statement-breakpoint
DROP TRIGGER IF EXISTS device_events_fk_same_org ON device_events;
--> statement-breakpoint
CREATE TRIGGER device_events_fk_same_org BEFORE INSERT OR UPDATE OF device_id, organization_id ON device_events
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('device_id', 'devices');
--> statement-breakpoint
-- Bestandsdaten melden (nicht ändern): je Praxis mit lokalem app.org_id (FORCE RLS gilt auch für einen
-- Nicht-Superuser-Owner, Muster wie 0049). Ausdrücklicher Filter auf organization_id, damit auch ein Superuser
-- (RLS umgangen) richtig zählt. Die Liste kommt aus den eben angelegten Triggern – eine Quelle für beides.
DO $$
DECLARE
  o record;
  t record;
  args text[];
  j int;
  n bigint;
  total bigint := 0;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    FOR t IN
      SELECT tg.tgrelid::regclass::text AS src, encode(tg.tgargs, 'escape') AS raw
        FROM pg_trigger tg
        JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE p.proname = 'podo_fk_same_org' AND NOT tg.tgisinternal
    LOOP
      -- tgargs: Argumente jeweils mit \000 abgeschlossen (encode … 'escape' liefert die vier Zeichen \000)
      args := string_to_array(regexp_replace(t.raw, '\\000$', ''), '\000');
      j := 1;
      WHILE j < coalesce(array_length(args, 1), 0) LOOP
        EXECUTE format(
          'SELECT count(*) FROM %s s WHERE s.organization_id = $1 AND s.%I IS NOT NULL'
          ' AND NOT EXISTS (SELECT 1 FROM public.%I x WHERE x.id = s.%I AND x.organization_id = $1)',
          t.src, args[j], args[j + 1], args[j]) INTO n USING o.id;
        IF n > 0 THEN
          total := total + n;
          RAISE NOTICE 'Praxis %: % Zeile(n) in %.% verweisen auf % einer anderen Praxis (Altbestand, bitte klären).',
            o.id, n, t.src, args[j], args[j + 1];
        END IF;
        j := j + 2;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
  IF total > 0 THEN
    RAISE NOTICE 'Praxisübergreifende Verweise im Altbestand: % Zeile(n). Neue Schreibvorgänge werden jetzt geprüft.', total;
  END IF;
END $$;
