-- Idempotent (mehrfach ausführbar). Vertrieb – Bedingungen der Rechtsprüfung (DSGVO/UWG):
-- 1. Herkunft je Lead: source (Quelle) + source_retrieved_at (Abrufdatum). Pflicht beim Anlegen und Import (App);
--    Altbestand der Praxissuche (OpenStreetMap) bekommt das Anlagedatum als Abrufdatum, übrige bleiben leer („fehlt“).
-- 2. Löschfrist delete_after: Erhebung + 6–12 Monate (Standard 12). Der nächtliche Lauf (/api/cron/lead-search →
--    purgeStaleLeads) löscht abgelaufene Einträge ohne gültige Einwilligung, außer bei Bestandskunden.
-- 3. Einwilligung je Kanal: E-Mail (bisherige Spalten consent_at/consent_note, Namen bleiben, damit die laufende
--    App-Version während des Deploys weiter funktioniert; dazu consent_email_kind, consent_email_revoked_at) und
--    Telefon (consent_phone_at/_kind/_note/_revoked_at). Bestehende Einwilligungen gelten als E-Mail-Einwilligung.
-- 4. art14_notice_at: Datum, an dem der Datenschutzhinweis nach Art. 14 DSGVO (Erstbrief) versendet wurde.
--
-- ALTBESTAND (bewusste Folge, siehe PR-Beschreibung): delete_after = greatest(created_at + 12 Monate, now() + 30 Tage).
-- Einträge, die älter als ca. 11 Monate sind, werden also NICHT sofort beim nächsten Nachtlauf gelöscht, sondern
-- frühestens 30 Tage nach dieser Migration (Zeit zum Prüfen, Einwilligung dokumentieren oder Status „Kunde“ setzen).
-- Danach löscht der Nachtlauf alle Einträge mit abgelaufenem delete_after ohne gültige Einwilligung und ohne
-- Bestandskunden-Bezug. Diese Einträge sind mit delete_after_legacy = true markiert; nur für sie lockert der CHECK die
-- Obergrenze „Erhebung + 12 Monate“ (die Schonfrist kann bei alten Einträgen weiter als 12 Monate ab Erhebung liegen).
-- Neue Einträge bekommen immer delete_after_legacy = false und damit die strenge Grenze 6–12 Monate.

ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "source_retrieved_at" date;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "delete_after_legacy" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_email_kind" text;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_email_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_phone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_phone_kind" text;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_phone_note" text;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "consent_phone_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "art14_notice_at" date;--> statement-breakpoint

UPDATE sales_leads SET source_retrieved_at = (created_at AT TIME ZONE 'Europe/Berlin')::date
 WHERE source_retrieved_at IS NULL AND source IN ('osm', 'osm+impressum');--> statement-breakpoint
-- Altbestand: frühestens 30 Tage nach der Migration löschbar (siehe Kopfkommentar)
UPDATE sales_leads
   SET delete_after = greatest(created_at + interval '12 months', now() + interval '30 days'),
       delete_after_legacy = (created_at + interval '12 months' < now() + interval '30 days')
 WHERE delete_after IS NULL;--> statement-breakpoint
ALTER TABLE "sales_leads" ALTER COLUMN "delete_after" SET DEFAULT (now() + interval '12 months');--> statement-breakpoint
ALTER TABLE "sales_leads" ALTER COLUMN "delete_after" SET NOT NULL;--> statement-breakpoint

-- Löschfrist 6–12 Monate ab Erhebung (1 Tag Spielraum für Uhrzeit/Zeitzone); Altbestand nach oben offen (Schonfrist)
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_delete_after_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_delete_after_check
  CHECK (delete_after >= created_at + interval '6 months' - interval '1 day'
     AND (delete_after <= created_at + interval '12 months' + interval '1 day' OR delete_after_legacy));--> statement-breakpoint

-- Abrufdatum plausibel (nicht in der Zukunft prüft die App; ein erneuter Abruf darf nach der Anlage liegen)
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_source_retrieved_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_source_retrieved_check
  CHECK (source_retrieved_at IS NULL OR source_retrieved_at >= DATE '2000-01-01');--> statement-breakpoint

-- E-Mail-Einwilligung: Art nur mit Datum (Altbestand darf ohne Art bleiben), Widerruf nur bei erteilter Einwilligung
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_kind_check;--> statement-breakpoint
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_email_kind_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_consent_email_kind_check
  CHECK (consent_email_kind IS NULL OR (consent_at IS NOT NULL AND consent_email_kind IN ('email', 'formular', 'schriftlich', 'persoenlich', 'telefon')));--> statement-breakpoint
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_email_revoked_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_consent_email_revoked_check
  CHECK (consent_email_revoked_at IS NULL OR consent_at IS NOT NULL);--> statement-breakpoint

-- Telefon-Einwilligung: Datum, Art und Wortlaut/Nachweis nur gemeinsam; Widerruf nur bei erteilter Einwilligung
ALTER TABLE sales_leads DROP CONSTRAINT IF EXISTS sales_leads_consent_phone_check;--> statement-breakpoint
ALTER TABLE sales_leads ADD CONSTRAINT sales_leads_consent_phone_check
  CHECK ((consent_phone_at IS NULL AND consent_phone_kind IS NULL AND consent_phone_note IS NULL AND consent_phone_revoked_at IS NULL)
      OR (consent_phone_at IS NOT NULL AND consent_phone_kind IN ('email', 'formular', 'schriftlich', 'persoenlich', 'telefon')
          AND consent_phone_note IS NOT NULL AND length(btrim(consent_phone_note)) BETWEEN 3 AND 500));--> statement-breakpoint

-- Verlauf: neue Art „letter“ (Datenschutzhinweis/Erstbrief versendet)
ALTER TABLE sales_lead_events DROP CONSTRAINT IF EXISTS sales_lead_events_kind_check;--> statement-breakpoint
ALTER TABLE sales_lead_events ADD CONSTRAINT sales_lead_events_kind_check CHECK (kind IN ('note', 'status', 'reply', 'campaign', 'consent', 'letter'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_leads_delete_after" ON "sales_leads" ("delete_after");
