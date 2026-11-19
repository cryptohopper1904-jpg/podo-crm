-- Praxis-Stammdaten (organizations) mandantensicher: Bisher hatte organizations keine RLS – die App-Rolle konnte per
-- UPDATE die Zeile JEDER Praxis ändern (und lesen), auch innerhalb von withOrg (AppSec, Härtung Org-RLS).
--
-- Regel (eine Policy für alle Befehle, USING und WITH CHECK):
--   * Mit Praxis-Kontext (app.org_id gesetzt, withOrg): nur die eigene Zeile – lesen, ändern, anlegen.
--   * Ohne Praxis-Kontext (app.org_id leer/ungesetzt): unverändert wie bisher. Das sind die bestehenden Sonderwege, die
--     legitim praxisübergreifend arbeiten: Anmeldung/Sitzung (Mitgliedschaften + Praxis), Registrierung/Einrichtung
--     (Insert der ersten Praxis, src/app/(auth)/actions.ts, src/lib/bootstrap.ts), Plattform-Konsole, Cron-Jobs,
--     Stripe-Webhooks, öffentliche Buchung/Website per Slug, Löschlauf als Eigentümer.
--   Praxisbezogene Schreibwege laufen deshalb über withOrg (Rest siehe PR-Beschreibung).
--
-- FORCE: gilt auch für den Tabellen-Eigentümer (Superuser umgehen RLS weiterhin). Fremdschlüssel-Prüfungen und
-- ON DELETE CASCADE umgehen RLS ohnehin. ACHTUNG für künftige Migrationen: Eine Schleife
-- „FOR o IN SELECT id FROM organizations LOOP PERFORM set_config('app.org_id', o.id, true) …“ sieht nach dem ersten
-- set_config nur noch diese Praxis – Liste vorher in ein Array lesen (array_agg) oder app.org_id in der Schleife leeren.
-- Idempotent.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_self ON "organizations";
--> statement-breakpoint
CREATE POLICY org_self ON "organizations"
  USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );
