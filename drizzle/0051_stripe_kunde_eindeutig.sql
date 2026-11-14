-- Ein Stripe-Kunde gehört genau einer Praxis (Webhook-Zuordnung über die Kunden-ID, src/server/billing.ts findOrg).
-- Idempotent. organizations hat keine RLS. Gibt es schon doppelte Kunden-IDs, wird der Index NICHT angelegt (die
-- Migration bricht den Deploy nicht ab) – Hinweis im Deploy-Log, Dubletten bereinigen und Migration erneut ausführen:
--   select stripe_customer_id, array_agg(id) from organizations where stripe_customer_id is not null group by 1 having count(*) > 1;
DO $$
DECLARE dubletten integer;
BEGIN
  SELECT count(*) INTO dubletten FROM (
    SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL GROUP BY stripe_customer_id HAVING count(*) > 1
  ) d;
  IF dubletten > 0 THEN
    RAISE WARNING 'organizations_stripe_customer_id nicht angelegt: % Stripe-Kunden-ID(s) mehrfach vergeben – bitte prüfen.', dubletten;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_customer_id" ON "organizations" USING btree ("stripe_customer_id") WHERE "organizations"."stripe_customer_id" is not null';
  END IF;
END $$;
