-- Nachhol-Versuche des Beleg-Archivs (Cron: Backoff, ältester Versuch zuerst). Idempotent (mehrfach ausführbar).
CREATE TABLE IF NOT EXISTS "archive_catchup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_catchup_attempts_organization_id_organizations_id_fk') THEN
    ALTER TABLE "archive_catchup_attempts" ADD CONSTRAINT "archive_catchup_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_catchup_attempts_values_check') THEN
    ALTER TABLE "archive_catchup_attempts" ADD CONSTRAINT "archive_catchup_attempts_values_check" CHECK (
      target_kind IN ('invoice', 'payment_receipt') AND attempts >= 0 AND (last_error IS NULL OR length(last_error) <= 300));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "archive_catchup_attempts_target" ON "archive_catchup_attempts" USING btree ("organization_id","target_kind","target_id");
--> statement-breakpoint
-- Mandantentrennung (RLS + FORCE)
ALTER TABLE archive_catchup_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE archive_catchup_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON archive_catchup_attempts;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON archive_catchup_attempts
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Ziel gehört zur Praxis (FK-los, daher explizit; RLS der Zieltabellen gilt über app.org_id ohnehin)
CREATE OR REPLACE FUNCTION podo_archive_catchup_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind = 'invoice'
     AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.target_id AND i.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Nachhol-Versuch: Beleg gehört nicht zur Praxis.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.target_kind = 'payment_receipt'
     AND NOT EXISTS (SELECT 1 FROM payment_receipts r WHERE r.id = NEW.target_id AND r.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Nachhol-Versuch: Zahlungsbeleg gehört nicht zur Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS archive_catchup_attempts_guard ON archive_catchup_attempts;
--> statement-breakpoint
CREATE TRIGGER archive_catchup_attempts_guard BEFORE INSERT OR UPDATE OF organization_id, target_kind, target_id ON archive_catchup_attempts
  FOR EACH ROW EXECUTE FUNCTION podo_archive_catchup_attempt_guard();
