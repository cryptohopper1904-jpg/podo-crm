-- Idempotent (mehrfach ausführbar). Vertrieb – Bedingungen der Rechtsprüfung (DSGVO/UWG):
-- 1. Herkunft je Lead: source (Quelle) + source_retrieved_at (Abrufdatum). Pflicht für neue Einträge (App);
--    Altbestand der Praxissuche (OpenStreetMap) bekommt das Anlagedatum als Abrufdatum, übrige bleiben leer („fehlt“).
-- 2. Löschfrist: delete_after (Standard Anlage + 12 Monate, in der Konsole 6–24 Monate). Der nächtliche Lauf
--    (/api/cron/lead-search → purgeStaleLeads) löscht abgelaufene Einträge ohne Status „Kunde“ und ohne Einwilligung.
-- 3. Einwilligung: consent_kind (Art) zusätzlich zu consent_at (Datum) und consent_note (Wortlaut/Nachweis).
-- Keine neuen SQL-Funktionen.

ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "source_retrieved_at" date;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_kind" text;--> statement-breakpoint

UPDATE sales_leads SET source_retrieved_at = (created_at AT TIME ZONE 'Europe/Berlin')::date
 WHERE source_retrieved_at IS NULL AND source IN ('osm', 'osm+impressum');--> statement-breakpoint
UPDATE sales_leads SET delete_after = created_at + interval '12 months' WHERE delete_after IS NULL;--> statement-breakpoint
ALTER TABLE "sales_leads" ALTER COLUMN "delete_after" SET DEFAULT (now() + interval '12 months');--> statement-breakpoint
ALTER TABLE "sales_leads" ALTER COLUMN "delete_after" SET NOT NULL;--> statement-breakpoint

-- Löschfrist 6–24 Monate ab Anlage (1 Tag Spielraum für Uhrzeit/Zeitzone)
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_delete_after_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_delete_after_check
  CHECK (delete_after >= created_at + interval '6 months' - interval '1 day' AND delete_after <= created_at + interval '24 months' + interval '1 day');--> statement-breakpoint

-- Abrufdatum plausibel (nicht in der Zukunft prüft die App; ein erneuter Abruf darf nach der Anlage liegen)
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_source_retrieved_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_source_retrieved_check
  CHECK (source_retrieved_at IS NULL OR source_retrieved_at >= DATE '2000-01-01');--> statement-breakpoint

-- Art der Einwilligung: nur zusammen mit consent_at; Altbestand (vor 0070) darf ohne Art bleiben
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_kind_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_consent_kind_check
  CHECK (consent_kind IS NULL OR (consent_at IS NOT NULL AND consent_kind IN ('email', 'formular', 'schriftlich', 'persoenlich', 'telefon')));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_leads_delete_after" ON "sales_leads" ("delete_after");
