-- Idempotent (CREATE OR REPLACE / REVOKE) – darf bei Umnummerierung erneut laufen. Folgepunkte aus den Reviews zu
-- *_user_praxis_abgleich (code-reviewer, appsec-engineer).
--
-- 1) EXECUTE für PUBLIC entziehen: podo_delete_patient, podo_calendar_feeds_active (liefert Feeds ALLER Praxen ohne
--    Kontext) und podo_calendar_feeds_health sind SECURITY DEFINER und waren für jede Rolle aufrufbar. Die App-Rolle
--    bekommt EXECUTE in scripts/migrate.ts (Rollenname konfigurierbar, DB_APP_ROLE) – wie die Tabellenrechte.
--    CREATE OR REPLACE behält Rechte; künftige Neufassungen dieser Funktionen müssen das REVOKE wiederholen
--    (der Test src/server/kontext-haertung.db.test.ts prüft es).
REVOKE ALL ON FUNCTION podo_delete_patient(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_calendar_feeds_active() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_calendar_feeds_health(interval) FROM PUBLIC;
--> statement-breakpoint
-- Trigger-Funktion (nicht direkt aufrufbar) – nur der Einheitlichkeit halber wie podo_fk_same_org/podo_user_in_org
REVOKE ALL ON FUNCTION podo_invoice_lines_guard() FROM PUBLIC;
--> statement-breakpoint
-- 2) podo_fk_same_org (0054) und podo_user_in_org (0056):
--    * leerer Kontext app.org_id bei Tabellen mit erzwungenem RLS → einheitlich 42501 statt Orakel (s. u.);
--    * podo_fk_same_org: unbekannte Spalte in den Trigger-Argumenten bricht laut ab (podo_user_in_org hat das seit 0056).
--    Sonst unverändert; Kommentare zu Aufbau und Gründen stehen in 0054 bzw. 0056. Rechte (REVOKE … FROM PUBLIC)
--    bleiben bei CREATE OR REPLACE erhalten.
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
  ok_ref boolean;
  label text;
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
    tbl := TG_ARGV[i + 1];
    i := i + 2;
    -- Tippfehler/umbenannte Spalte in den Trigger-Argumenten: laut scheitern statt still nichts zu prüfen
    IF NOT (new_row ? col) THEN
      RAISE EXCEPTION 'podo_fk_same_org: Spalte %.% fehlt (Trigger-Argumente prüfen)', TG_TABLE_NAME, col;
    END IF;
    ref := new_row ->> col;
    CONTINUE WHEN ref IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE'
      AND ref IS NOT DISTINCT FROM (old_row ->> col)
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id;
    IF NOT ctx_set THEN
      -- Erst hier (vor dem ersten Lookup), nicht am Anfang: Schreibvorgänge ohne Lookup (NULL setzen, Verweis
      -- unverändert) brauchen keine Prüfung – z. B. ON DELETE SET NULL, ausgelöst aus einer anderen Praxis.
      -- Zeile für eine andere Praxis als den gesetzten Kontext: ohne Lookup ablehnen. Sonst wäre die Funktion (sie
      -- liest als Eigentümer im Kontext der NEUEN Zeile) ein Orakel „gehört Datensatz X zu Praxis Y?“ – die
      -- RLS-Prüfung (WITH CHECK) läuft erst nach den BEFORE-Triggern. Ohne Kontext (Owner-/Superuser-Wartung) wird
      -- normal geprüft.
      -- Leerer Kontext (AppSec L1): Für Tabellen mit erzwungenem RLS würde die Policy die Zeile ohnehin ablehnen – vorher
      -- aber verriete die Antwort (Trigger-Fehler vs. RLS-Fehler), ob der Verweis in der Zielpraxis existiert. Deshalb
      -- einheitlich ablehnen, außer für Rollen, die RLS umgehen (Superuser-Wartung). Tabellen ohne RLS (patient_links,
      -- promo_redemptions) bleiben wie bisher: dort ist dieser Trigger die einzige Prüfung.
      IF prev_org = ''
         AND (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = TG_RELID)
         AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND (r.rolsuper OR r.rolbypassrls)) THEN
        RAISE EXCEPTION 'Kein Praxis-Kontext gesetzt.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF prev_org <> '' AND prev_org <> NEW.organization_id::text THEN
        RAISE EXCEPTION 'Zeile gehört nicht zur Praxis des aktuellen Kontexts.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- nur für die Abfragen dieser Funktion; Wert des Aufrufers am Ende wiederherstellen
      PERFORM set_config('app.org_id', NEW.organization_id::text, true);
      ctx_set := true;
    END IF;
    -- (organization_id, id): passt zum eindeutigen Index <tabelle>_org_id (Index-Only-Scan)
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I t WHERE t.organization_id = $1 AND t.id = $2)', tbl)
      INTO ok_ref USING NEW.organization_id, ref::uuid;
    IF NOT ok_ref THEN
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
  IF ctx_set THEN
    PERFORM set_config('app.org_id', prev_org, true);
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
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
    -- Tippfehler/umbenannte Spalte in den Trigger-Argumenten: laut scheitern statt still nichts zu prüfen
    IF NOT (new_row ? col) THEN
      RAISE EXCEPTION 'podo_user_in_org: Spalte %.% fehlt (Trigger-Argumente prüfen)', TG_TABLE_NAME, col;
    END IF;
    ref := (new_row ->> col)::uuid;
    IF ref IS NULL AND kind = 'support'
       AND (TG_OP = 'INSERT' OR (old_row ->> col) IS NOT NULL) THEN
      RAISE EXCEPTION 'Diese Person kann keinen Support-Zugriff erhalten.'
        USING ERRCODE = 'foreign_key_violation', DETAIL = format('%s.%s', TG_TABLE_NAME, col);
    END IF;
    CONTINUE WHEN ref IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE'
      AND ref IS NOT DISTINCT FROM (old_row ->> col)::uuid
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id;
    IF NOT ctx_set THEN
      -- erst vor dem ersten nötigen Lookup (wie podo_fk_same_org)
      -- Leerer Kontext (AppSec L1): Für Tabellen mit erzwungenem RLS würde die Policy die Zeile ohnehin ablehnen – vorher
      -- aber verriete die Antwort (Trigger-Fehler vs. RLS-Fehler), ob der Verweis in der Zielpraxis existiert. Deshalb
      -- einheitlich ablehnen, außer für Rollen, die RLS umgehen (Superuser-Wartung). Tabellen ohne RLS (patient_links,
      -- promo_redemptions) bleiben wie bisher: dort ist dieser Trigger die einzige Prüfung.
      IF prev_org = ''
         AND (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = TG_RELID)
         AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND (r.rolsuper OR r.rolbypassrls)) THEN
        RAISE EXCEPTION 'Kein Praxis-Kontext gesetzt.' USING ERRCODE = 'insufficient_privilege';
      END IF;
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
