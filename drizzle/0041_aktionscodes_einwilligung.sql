-- Idempotent (mehrfach ausführbar). Einwilligung in Werbe-E-Mails (§ 7 Abs. 2 Nr. 2 UWG) je Lead: nur mit Vermerk, wie/wann erteilt.
-- previous_plan: Tarif vor dem Einlösen eines Aktionscodes (z. B. „free“ → nach Ablauf automatisch zurück).
ALTER TABLE "promo_redemptions" ADD COLUMN IF NOT EXISTS "previous_plan" text;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_note" text;--> statement-breakpoint
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_consent_check
  CHECK ((consent_at IS NULL AND consent_note IS NULL) OR (consent_at IS NOT NULL AND consent_note IS NOT NULL AND length(btrim(consent_note)) BETWEEN 3 AND 500));
--> statement-breakpoint
-- Verlauf: auch Einwilligung dokumentiert/entfernt
ALTER TABLE sales_lead_events DROP CONSTRAINT IF EXISTS sales_lead_events_kind_check;--> statement-breakpoint
ALTER TABLE sales_lead_events ADD CONSTRAINT sales_lead_events_kind_check CHECK (kind IN ('note', 'status', 'reply', 'campaign', 'consent'));
