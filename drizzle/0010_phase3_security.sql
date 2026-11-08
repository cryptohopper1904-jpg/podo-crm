-- Phase 3: Mandantentrennung für neue Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_grants','voice_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- billing_events: plattformweit (Stripe-Webhooks kennen den Mandanten erst nach Auswertung) – bewusst ohne RLS,
-- enthält keine Gesundheitsdaten.
-- Bestehende Praxen: 30 Tage Testphase ab Migration
UPDATE organizations SET trial_ends_at = now() + interval '30 days' WHERE trial_ends_at IS NULL;
