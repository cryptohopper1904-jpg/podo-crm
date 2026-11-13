-- Idempotent (IF NOT EXISTS / DROP … IF EXISTS) – darf bei Umnummerierung erneut laufen.
-- Kalender-Sperrzeiten (Pause, Schulung, früher Feierabend, Wartung, Reinigung …) je Person oder ganze Praxis (user_id NULL).
CREATE TABLE IF NOT EXISTS "calendar_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" text DEFAULT 'pause' NOT NULL,
	"title" text,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_time" text,
	"end_time" text,
	"repeat" text DEFAULT 'none' NOT NULL,
	"weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"interval_weeks" smallint DEFAULT 1 NOT NULL,
	"exceptions" date[] DEFAULT '{}'::date[] NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_blocks_organization_id_organizations_id_fk') THEN
    ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_blocks_user_id_users_id_fk') THEN
    ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_blocks_created_by_users_id_fk') THEN
    ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_blocks_org_start" ON "calendar_blocks" USING btree ("organization_id","starts_on");
--> statement-breakpoint
-- Mandantentrennung (RLS + FORCE) wie bei den übrigen Praxis-Tabellen
ALTER TABLE "calendar_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "calendar_blocks";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "calendar_blocks"
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Zweite Sicherung neben der App-Prüfung: gültige Art/Wiederholung/Zeiten
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_blocks_valid_check') THEN
    ALTER TABLE calendar_blocks ADD CONSTRAINT calendar_blocks_valid_check CHECK (
  kind IN ('pause', 'schulung', 'feierabend', 'wartung', 'reinigung', 'sonstiges')
  AND repeat IN ('none', 'daily', 'weekly')
  AND (ends_on IS NULL OR ends_on >= starts_on)
  AND interval_weeks BETWEEN 1 AND 12
  AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
  AND (repeat <> 'weekly' OR cardinality(weekdays) > 0)
  AND cardinality(exceptions) <= 500
  AND (title IS NULL OR length(title) <= 120)
  AND (note IS NULL OR length(note) <= 1000)
  AND (
    (all_day AND start_time IS NULL AND end_time IS NULL)
    OR (
      NOT all_day
      AND start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR end_time = '24:00')
      AND end_time > start_time
    )
  )
);
  END IF;
END $$;
--> statement-breakpoint
-- Fremdschlüssel-Prüfungen umgehen RLS: Person und Ersteller:in nur aus derselben Praxis
CREATE OR REPLACE FUNCTION podo_calendar_blocks_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = NEW.user_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Person gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.created_by IS DISTINCT FROM OLD.created_by)
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = NEW.created_by AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Ersteller:in gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Sperrzeiten wechseln nicht die Praxis.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS calendar_blocks_org ON calendar_blocks;
--> statement-breakpoint
CREATE TRIGGER calendar_blocks_org BEFORE INSERT OR UPDATE OF user_id, created_by, organization_id ON calendar_blocks
  FOR EACH ROW EXECUTE FUNCTION podo_calendar_blocks_org();
