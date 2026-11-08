-- Phase 2: Mandantentrennung und Unveränderbarkeit für neue Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_batches','reminder_log','devices','device_events','materials','working_hours','absences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- patient_links bewusst OHNE RLS: öffentliche Links werden nur über den Token-Hash gefunden (wie sessions);
-- der App-Code setzt danach den Mandanten aus dem gefundenen Datensatz.
-- Gerätebuch ist ein Nachweis (MPBetreibV): nur anhängen, nie ändern/löschen
CREATE TRIGGER device_events_no_update BEFORE UPDATE OR DELETE ON device_events
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_change();
--> statement-breakpoint
CREATE TRIGGER device_events_no_truncate BEFORE TRUNCATE ON device_events
  FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate();
--> statement-breakpoint
-- Freigegebene Sterilgut-Chargen sind unveränderbar (Rückverfolgbarkeit)
CREATE OR REPLACE FUNCTION podo_sterile_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sterilgut-Chargen werden nicht gelöscht.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.result <> 'pending' THEN
    RAISE EXCEPTION 'Freigabe/Sperre einer Charge ist endgültig.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Chargennummer ist unveränderbar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sterile_batches_guard BEFORE UPDATE OR DELETE ON sterile_batches
  FOR EACH ROW EXECUTE FUNCTION podo_sterile_batch_guard();
