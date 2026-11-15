-- Idempotent (ALTER … SET / CREATE OR REPLACE / DROP … IF EXISTS) – darf bei Umnummerierung erneut laufen.
--
-- Teil 1: Fester search_path für alle SECURITY-DEFINER-Funktionen (AppSec-Befund).
-- podo_invoice_lines_guard (0005) lief mit `search_path = public`. Ohne ausdrückliches pg_temp sucht Postgres das
-- temporäre Schema einer Sitzung für Tabellen ZUERST – eine Rolle mit TEMP-Recht (Standard für PUBLIC) könnte mit
-- `create temp table invoices (…)` die Rechnungsprüfung des Triggers auf eine eigene Tabelle umlenken und so Positionen
-- ausgestellter Rechnungen ändern. Einheitlich `pg_catalog, public, pg_temp` (pg_temp ausdrücklich zuletzt) auch für
-- die übrigen Definer-Funktionen; dort stand pg_temp schon am Ende, die Angleichung ist reine Vereinheitlichung.
-- Der Test src/server/user-praxis.db.test.ts prüft das für jede SECURITY-DEFINER-Funktion im Schema public.
ALTER FUNCTION podo_invoice_lines_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION podo_delete_patient(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION podo_calendar_feeds_active() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION podo_calendar_feeds_health(interval) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
-- Teil 2: Verweise auf Benutzer:innen nur innerhalb der Praxis (AppSec-Befund, Ergänzung zu *_fk_praxis_abgleich).
--
-- `users` ist plattformweit (keine organization_id, kein RLS); der Fremdschlüssel prüft nur, dass es die Person gibt.
-- Ein Mitglied von Praxis A konnte so einen Termin, eine Aufgabe, eine Fahrt … einer beliebigen Person einer anderen
-- Praxis zuordnen. Die App prüft die Auswahl bereits (z. B. isCalendarMember); dieser Trigger ist die zweite Sicherung.
--
-- Arten (Trigger-Argumente: Paare Spalte, Art):
--  * member  – Zuordnung zu einer Person der Praxis (Behandler:in, zuständig, Fahrer:in, Abwesenheit …):
--              Mitgliedschaft in der Praxis der Zeile (memberships, unabhängig von active – wie calendar_blocks in 0047;
--              Altzeilen deaktivierter Personen bleiben bearbeitbar, die Auswahl aktiver Personen leistet die App).
--  * actor   – wer gehandelt hat (created_by, author_id, uploaded_by …): Mitglied der Praxis ODER Plattform-Admin mit
--              2FA und gerade gültiger Support-Freigabe für diese Praxis (Break-Glass, src/server/support.ts – Support
--              hat keine Mitgliedschaft, kann aber z. B. mit Umfang „write“ Einstellungen ändern oder Belege abrufen).
--              Unabhängig vom Umfang der Freigabe: was Support schreiben darf, begrenzt die App (effectiveCan).
--  * support – support_grants.grantee_user_id: die Person beim Support hat gerade KEINE Mitgliedschaft; erlaubt ist nur
--              ein Plattform-Admin mit 2FA (wie isEligibleSupportAdmin in der App).
-- Für unbekannte und fremde Personen dieselbe Meldung (kein Existenz-Orakel über die Benutzer-UUID). Der Trigger läuft
-- vor der Fremdschlüssel-Prüfung (die ist ein AFTER-Trigger), eine unbekannte UUID landet also ebenfalls hier.
--
-- Muster wie podo_fk_same_org (0054): SECURITY DEFINER mit festem search_path; Zeile einer anderen Praxis als im
-- Kontext app.org_id wird ohne Lookup abgelehnt (sonst Orakel „ist Person X Mitglied von Praxis Y?“, die RLS-Prüfung
-- WITH CHECK läuft erst nach den BEFORE-Triggern); für die Freigaben-Abfrage (support_grants: RLS + FORCE, gilt auch
-- für einen Nicht-Superuser-Owner) wird app.org_id lokal auf die Praxis der Zeile gesetzt und danach zurückgesetzt.
-- Bei UPDATE nur, wenn sich der Verweis oder die Praxis ändert (Altbestand bleibt bearbeitbar, ON DELETE SET NULL
-- braucht keinen Lookup).
--
-- Bewusst nicht abgedeckt (Liste im Vollständigkeitstest): memberships.user_id (definiert die Mitgliedschaft selbst),
-- sessions.user_id (Anmeldung, plattformweit; Support-Sitzungen stehen in einer Praxis ohne Mitgliedschaft).
--
-- Pflege: Spalten stehen als Text in den Trigger-Argumenten; der Test src/server/user-praxis.db.test.ts schlägt fehl,
-- wenn ein neuer Verweis auf users aus einer Praxis-Tabelle weder hier noch in der Ausnahmeliste steht.
CREATE OR REPLACE FUNCTION podo_user_in_org() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb;
  i int := 0;
  col text;
  kind text;
  ref uuid;
  ok_ref boolean;
  prev_org text;
  ctx_set boolean := false;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW; -- NOT NULL der Spalte greift
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
  END IF;
  prev_org := coalesce(current_setting('app.org_id', true), '');
  WHILE i + 1 < TG_NARGS LOOP
    col := TG_ARGV[i];
    kind := TG_ARGV[i + 1];
    i := i + 2;
    ref := (new_row ->> col)::uuid;
    CONTINUE WHEN ref IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE'
      AND ref IS NOT DISTINCT FROM (old_row ->> col)::uuid
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id;
    IF NOT ctx_set THEN
      -- erst vor dem ersten nötigen Lookup (wie podo_fk_same_org)
      IF prev_org <> '' AND prev_org <> NEW.organization_id::text THEN
        RAISE EXCEPTION 'Zeile gehört nicht zur Praxis des aktuellen Kontexts.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      PERFORM set_config('app.org_id', NEW.organization_id::text, true);
      ctx_set := true;
    END IF;
    IF kind = 'support' THEN
      SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = ref AND u.is_platform_admin AND u.totp_enabled) INTO ok_ref;
      IF NOT ok_ref THEN
        RAISE EXCEPTION 'Diese Person kann keinen Support-Zugriff erhalten.'
          USING ERRCODE = 'foreign_key_violation', DETAIL = format('%s.%s', TG_TABLE_NAME, col);
      END IF;
      CONTINUE;
    END IF;
    -- (organization_id, user_id): eindeutiger Index memberships_org_user
    SELECT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = NEW.organization_id AND m.user_id = ref) INTO ok_ref;
    IF NOT ok_ref AND kind = 'actor' THEN
      SELECT EXISTS (
        SELECT 1
          FROM public.users u
          JOIN public.support_grants g ON g.organization_id = NEW.organization_id
                                     AND (g.grantee_user_id = u.id OR g.grantee_user_id IS NULL)
         WHERE u.id = ref AND u.is_platform_admin AND u.totp_enabled
           AND g.revoked_at IS NULL AND g.expires_at > now()
      ) INTO ok_ref;
    ELSIF kind NOT IN ('member', 'actor') THEN
      RAISE EXCEPTION 'podo_user_in_org: unbekannte Art % für %.%', kind, TG_TABLE_NAME, col;
    END IF;
    IF NOT ok_ref THEN
      RAISE EXCEPTION 'Person gehört nicht zu dieser Praxis.'
        USING ERRCODE = 'foreign_key_violation', DETAIL = format('%s.%s', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  IF ctx_set THEN
    PERFORM set_config('app.org_id', prev_org, true);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_user_in_org() FROM PUBLIC;
--> statement-breakpoint
-- calendar_blocks (0047): Personen-Prüfung wandert in den gemeinsamen Trigger (dort mit Kontextprüfung – der alte
-- Trigger beantwortete für eine Zeile einer fremden Praxis, ob die Person dort Mitglied ist). Übrig bleibt hier nur
-- „kein Praxiswechsel“.
CREATE OR REPLACE FUNCTION podo_calendar_blocks_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Sperrzeiten wechseln nicht die Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS calendar_blocks_org ON calendar_blocks;
--> statement-breakpoint
CREATE TRIGGER calendar_blocks_org BEFORE UPDATE OF organization_id ON calendar_blocks
  FOR EACH ROW EXECUTE FUNCTION podo_calendar_blocks_org();
--> statement-breakpoint
-- Argumente: Paare (Spalte, Art). UPDATE OF: nur die Verweise und organization_id.
DROP TRIGGER IF EXISTS absences_user_in_org ON absences;
--> statement-breakpoint
CREATE TRIGGER absences_user_in_org BEFORE INSERT OR UPDATE OF user_id, organization_id ON absences
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('user_id', 'member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS anamneses_user_in_org ON anamneses;
--> statement-breakpoint
CREATE TRIGGER anamneses_user_in_org BEFORE INSERT OR UPDATE OF author_id, organization_id ON anamneses
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('author_id', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS appointments_user_in_org ON appointments;
--> statement-breakpoint
CREATE TRIGGER appointments_user_in_org BEFORE INSERT OR UPDATE OF therapist_id, organization_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('therapist_id', 'member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batches_user_in_org ON billing_batches;
--> statement-breakpoint
CREATE TRIGGER billing_batches_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON billing_batches
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS calendar_blocks_user_in_org ON calendar_blocks;
--> statement-breakpoint
CREATE TRIGGER calendar_blocks_user_in_org BEFORE INSERT OR UPDATE OF user_id, created_by, organization_id ON calendar_blocks
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('user_id', 'member', 'created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS calendar_feeds_user_in_org ON calendar_feeds;
--> statement-breakpoint
CREATE TRIGGER calendar_feeds_user_in_org BEFORE INSERT OR UPDATE OF therapist_id, organization_id ON calendar_feeds
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('therapist_id', 'member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_closings_user_in_org ON cash_closings;
--> statement-breakpoint
CREATE TRIGGER cash_closings_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_movements_user_in_org ON cash_movements;
--> statement-breakpoint
CREATE TRIGGER cash_movements_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS consents_user_in_org ON consents;
--> statement-breakpoint
CREATE TRIGGER consents_user_in_org BEFORE INSERT OR UPDATE OF recorded_by, organization_id ON consents
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('recorded_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS device_events_user_in_org ON device_events;
--> statement-breakpoint
CREATE TRIGGER device_events_user_in_org BEFORE INSERT OR UPDATE OF author_id, organization_id ON device_events
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('author_id', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_archive_user_in_org ON document_archive;
--> statement-breakpoint
CREATE TRIGGER document_archive_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON document_archive
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_dunnings_user_in_org ON invoice_dunnings;
--> statement-breakpoint
CREATE TRIGGER invoice_dunnings_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON invoice_dunnings
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_user_in_org ON invoices;
--> statement-breakpoint
CREATE TRIGGER invoices_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS media_user_in_org ON media;
--> statement-breakpoint
CREATE TRIGGER media_user_in_org BEFORE INSERT OR UPDATE OF uploaded_by, organization_id ON media
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('uploaded_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS organization_logos_user_in_org ON organization_logos;
--> statement-breakpoint
CREATE TRIGGER organization_logos_user_in_org BEFORE INSERT OR UPDATE OF uploaded_by, organization_id ON organization_logos
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('uploaded_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS patient_links_user_in_org ON patient_links;
--> statement-breakpoint
CREATE TRIGGER patient_links_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON patient_links
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_receipts_user_in_org ON payment_receipts;
--> statement-breakpoint
CREATE TRIGGER payment_receipts_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS payments_user_in_org ON payments;
--> statement-breakpoint
CREATE TRIGGER payments_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON payments
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS prescriptions_user_in_org ON prescriptions;
--> statement-breakpoint
CREATE TRIGGER prescriptions_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS promo_redemptions_user_in_org ON promo_redemptions;
--> statement-breakpoint
CREATE TRIGGER promo_redemptions_user_in_org BEFORE INSERT OR UPDATE OF redeemed_by, organization_id ON promo_redemptions
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('redeemed_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS record_addenda_user_in_org ON record_addenda;
--> statement-breakpoint
CREATE TRIGGER record_addenda_user_in_org BEFORE INSERT OR UPDATE OF author_id, organization_id ON record_addenda
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('author_id', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS sterile_batches_user_in_org ON sterile_batches;
--> statement-breakpoint
CREATE TRIGGER sterile_batches_user_in_org BEFORE INSERT OR UPDATE OF released_by, organization_id ON sterile_batches
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('released_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS stock_movements_user_in_org ON stock_movements;
--> statement-breakpoint
CREATE TRIGGER stock_movements_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS support_grants_user_in_org ON support_grants;
--> statement-breakpoint
CREATE TRIGGER support_grants_user_in_org BEFORE INSERT OR UPDATE OF granted_by, grantee_user_id, organization_id ON support_grants
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('granted_by', 'member', 'grantee_user_id', 'support');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_user_in_org ON tasks;
--> statement-breakpoint
CREATE TRIGGER tasks_user_in_org BEFORE INSERT OR UPDATE OF assignee_id, organization_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('assignee_id', 'member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS treatment_records_user_in_org ON treatment_records;
--> statement-breakpoint
CREATE TRIGGER treatment_records_user_in_org BEFORE INSERT OR UPDATE OF author_id, organization_id ON treatment_records
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('author_id', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS trip_corrections_user_in_org ON trip_corrections;
--> statement-breakpoint
CREATE TRIGGER trip_corrections_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON trip_corrections
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS trips_user_in_org ON trips;
--> statement-breakpoint
CREATE TRIGGER trips_user_in_org BEFORE INSERT OR UPDATE OF driver_id, created_by, organization_id ON trips
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('driver_id', 'member', 'created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS working_hours_user_in_org ON working_hours;
--> statement-breakpoint
CREATE TRIGGER working_hours_user_in_org BEFORE INSERT OR UPDATE OF user_id, organization_id ON working_hours
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('user_id', 'member');
--> statement-breakpoint
-- Bestandsdaten melden (nicht ändern), Muster wie 0054: je Praxis mit lokalem app.org_id, ausdrücklicher Filter auf
-- organization_id. Für „actor“ zählt ein Plattform-Admin als plausibel (Support-Freigabe von damals ist nicht mehr
-- sicher nachzuprüfen). Die Liste kommt aus den eben angelegten Triggern.
DO $$
DECLARE
  o record;
  t record;
  args text[];
  j int;
  n bigint;
  total bigint := 0;
  cond text;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    FOR t IN
      SELECT tg.tgrelid::regclass::text AS src, encode(tg.tgargs, 'escape') AS raw
        FROM pg_trigger tg
        JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE p.proname = 'podo_user_in_org' AND NOT tg.tgisinternal
    LOOP
      args := string_to_array(regexp_replace(t.raw, '\\000$', ''), '\000');
      j := 1;
      WHILE j < coalesce(array_length(args, 1), 0) LOOP
        cond := CASE args[j + 1]
          WHEN 'support' THEN format('NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.%I AND u.is_platform_admin)', args[j])
          WHEN 'actor' THEN format('NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = $1 AND m.user_id = s.%I)'
                                   ' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.%I AND u.is_platform_admin)', args[j], args[j])
          ELSE format('NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = $1 AND m.user_id = s.%I)', args[j])
        END;
        EXECUTE format('SELECT count(*) FROM %s s WHERE s.organization_id = $1 AND s.%I IS NOT NULL AND ', t.src, args[j]) || cond
          INTO n USING o.id;
        IF n > 0 THEN
          total := total + n;
          RAISE NOTICE 'Praxis %: % Zeile(n) in %.% verweisen auf eine Person außerhalb der Praxis (Altbestand, bitte klären).',
            o.id, n, t.src, args[j];
        END IF;
        j := j + 2;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
  IF total > 0 THEN
    RAISE NOTICE 'Personen-Verweise außerhalb der Praxis im Altbestand: % Zeile(n). Neue Schreibvorgänge werden jetzt geprüft.', total;
  END IF;
END $$;
