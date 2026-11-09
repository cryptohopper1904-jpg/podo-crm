-- Kalender-Abo (iCal-Import): Mandantentrennung für die neuen Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_feeds','calendar_feed_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Zuordnung muss zur Praxis des Abos gehören (zweite Sicherung neben RLS)
CREATE OR REPLACE FUNCTION podo_calendar_feed_event_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calendar_feeds f WHERE f.id = NEW.feed_id AND f.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Kalender-Abo gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER calendar_feed_events_org BEFORE INSERT OR UPDATE OF feed_id, organization_id ON calendar_feed_events
  FOR EACH ROW EXECUTE FUNCTION podo_calendar_feed_event_org();
--> statement-breakpoint
-- Lesen über alle Praxen NUR für den Tabelleneigentümer, d. h. innerhalb der SECURITY-DEFINER-Funktionen unten
-- (die App-Rolle ist nie Eigentümer). Schreiben bleibt an tenant_isolation gebunden.
CREATE POLICY owner_read ON calendar_feeds FOR SELECT
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'calendar_feeds'::regclass));
--> statement-breakpoint
-- Cron: fällige Abos über alle Praxen – liefert NUR IDs (keine URL, keine Inhalte). Der eigentliche Abgleich
-- läuft danach je Praxis mit app.org_id (RLS).
CREATE OR REPLACE FUNCTION podo_calendar_feeds_active() RETURNS TABLE (id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.id, f.organization_id FROM calendar_feeds f
    JOIN organizations o ON o.id = f.organization_id
   WHERE f.active AND o.deletion_requested_at IS NULL
   ORDER BY f.last_attempt_at NULLS FIRST
$$;
--> statement-breakpoint
-- /api/health/deep: nur Zähler und Zeitpunkte über alle aktiven Abos (keine Personendaten, keine Fehlertexte)
CREATE OR REPLACE FUNCTION podo_calendar_feeds_health(stale_after interval)
  RETURNS TABLE (active integer, stale integer, failing integer, oldest_success timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE coalesce(f.last_sync_at, f.created_at) < now() - stale_after)::int,
         count(*) FILTER (WHERE f.last_error IS NOT NULL)::int,
         min(f.last_sync_at)
    FROM calendar_feeds f
    JOIN organizations o ON o.id = f.organization_id
   WHERE f.active AND o.deletion_requested_at IS NULL
$$;
