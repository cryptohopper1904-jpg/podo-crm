-- Fahrten & Hausbesuchs-Touren: Mandantentrennung (RLS + FORCE) und Unveränderbarkeit des Fahrtenbuchs
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_start_locations','trips','trip_corrections','route_cache','geocode_cache'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Fahrtenbuch: nur anhängen, Korrekturen als Nachtrag (trip_corrections)
CREATE OR REPLACE FUNCTION podo_forbid_trip_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Fahrtenbuch-Einträge sind unveränderbar (%). Bitte eine Korrektur anlegen.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trips','trip_corrections'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION podo_forbid_trip_change()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Korrektur nur zu einer Fahrt derselben Praxis
CREATE OR REPLACE FUNCTION podo_trip_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trips t WHERE t.id = NEW.trip_id AND t.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Fahrt gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_corrections_guard BEFORE INSERT ON trip_corrections
  FOR EACH ROW EXECUTE FUNCTION podo_trip_correction_guard();
--> statement-breakpoint
-- Plausibilität (auch gegen Fehlbedienung): Strecke 0 … 2000 km
ALTER TABLE trips ADD CONSTRAINT trips_distance_range CHECK (distance_m >= 0 AND distance_m <= 2000000);
--> statement-breakpoint
ALTER TABLE trip_corrections ADD CONSTRAINT trip_corrections_distance_range CHECK (distance_m IS NULL OR (distance_m >= 0 AND distance_m <= 2000000));
