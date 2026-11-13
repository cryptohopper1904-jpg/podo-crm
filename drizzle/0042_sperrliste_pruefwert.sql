-- Idempotent. Sperrliste nur noch als Prüfwert (HMAC, Schlüssel nur in der App), je Art: E-Mail, Website-Host, Name+PLZ.
-- Den Altbestand aus sales_suppressions überführt die App beim ersten Zugriff (src/server/blocklist.ts) und löscht den Klartext.
CREATE TABLE IF NOT EXISTS "sales_blocklist" (
	"hash" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'email' NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_blocklist" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'email' NOT NULL;
--> statement-breakpoint
REVOKE ALL ON sales_blocklist FROM PUBLIC;
--> statement-breakpoint
-- Schlüsselversion im Präfix (v1:, später v2: … per Schlüsselbund, siehe docs/BETRIEB.md)
ALTER TABLE sales_blocklist DROP CONSTRAINT IF EXISTS sales_blocklist_hash_check;--> statement-breakpoint
ALTER TABLE sales_blocklist ADD CONSTRAINT sales_blocklist_hash_check CHECK (hash ~ '^v[0-9]+:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE sales_blocklist DROP CONSTRAINT IF EXISTS sales_blocklist_reason_check;--> statement-breakpoint
ALTER TABLE sales_blocklist ADD CONSTRAINT sales_blocklist_reason_check CHECK (reason IN ('abgemeldet', 'manuell', 'widerspruch'));
--> statement-breakpoint
ALTER TABLE sales_blocklist DROP CONSTRAINT IF EXISTS sales_blocklist_kind_check;--> statement-breakpoint
ALTER TABLE sales_blocklist ADD CONSTRAINT sales_blocklist_kind_check CHECK (kind IN ('email', 'host', 'namezip'));
--> statement-breakpoint
-- Der DB-Trigger aus 0028 glich Leads gegen Klartext-Adressen ab; ohne Klartext prüft die App (Anlegen, Import,
-- Praxissuche, Versand unter Sperre). Abgemeldete Leads werden gelöscht, nur die Prüfwerte bleiben.
DROP TRIGGER IF EXISTS sales_leads_suppressed ON sales_leads;
--> statement-breakpoint
DROP FUNCTION IF EXISTS podo_sales_lead_suppressed_guard();
--> statement-breakpoint
-- Vertriebs-Versand erst, wenn der Betreiber den E-Mail-Versanddienstleister (mit AVV) als eingetragen bestätigt hat
ALTER TABLE "sales_settings" ADD COLUMN IF NOT EXISTS "mail_processor_confirmed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Kanarienwert des Sperrlisten-Schlüssels (fail-closed, wenn APP_ENCRYPTION_KEY getauscht wurde)
ALTER TABLE "sales_settings" ADD COLUMN IF NOT EXISTS "blocklist_key_check" text;
