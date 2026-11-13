-- Idempotent. Sperrliste nur noch als Prüfwert (HMAC der kleingeschriebenen Adresse, Schlüssel nur in der App).
-- Den Altbestand aus sales_suppressions überführt die App beim ersten Zugriff (src/server/blocklist.ts) und löscht den Klartext.
CREATE TABLE IF NOT EXISTS "sales_blocklist" (
	"hash" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON sales_blocklist FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE sales_blocklist DROP CONSTRAINT IF EXISTS sales_blocklist_hash_check;--> statement-breakpoint
ALTER TABLE sales_blocklist ADD CONSTRAINT sales_blocklist_hash_check CHECK (hash ~ '^v1:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE sales_blocklist DROP CONSTRAINT IF EXISTS sales_blocklist_reason_check;--> statement-breakpoint
ALTER TABLE sales_blocklist ADD CONSTRAINT sales_blocklist_reason_check CHECK (reason IN ('abgemeldet', 'manuell', 'widerspruch'));
--> statement-breakpoint
-- Der DB-Trigger aus 0028 glich Leads gegen Klartext-Adressen ab; ohne Klartext prüft die App (Anlegen, Import,
-- Praxissuche, Versand unter Sperre). Abgemeldete Leads werden gelöscht, nur der Prüfwert bleibt.
DROP TRIGGER IF EXISTS sales_leads_suppressed ON sales_leads;
--> statement-breakpoint
DROP FUNCTION IF EXISTS podo_sales_lead_suppressed_guard();
