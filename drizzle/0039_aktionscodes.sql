-- Idempotent (mehrfach ausführbar, wie 0033): Tabellen/Spalten/Indizes nur, wenn sie fehlen; Fremdschlüssel per DO-Block.
CREATE TABLE IF NOT EXISTS "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"trial_days" smallint NOT NULL,
	"grant_plan" text,
	"max_redemptions" integer,
	"valid_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"campaign_id" uuid,
	"lead_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promo_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"redeemed_by" uuid,
	"via" text NOT NULL,
	"trial_ends_before" timestamp with time zone,
	"trial_ends_after" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"templates" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"meta" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD COLUMN IF NOT EXISTS "replied_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_campaign_id_sales_campaigns_id_fk') THEN
    ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_campaign_id_sales_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sales_campaigns"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_lead_id_sales_leads_id_fk') THEN
    ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_lead_id_sales_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."sales_leads"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_created_by_users_id_fk') THEN
    ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_redemptions_code_id_promo_codes_id_fk') THEN
    ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_code_id_promo_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."promo_codes"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_redemptions_organization_id_organizations_id_fk') THEN
    ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_redemptions_redeemed_by_users_id_fk') THEN
    ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_campaigns_created_by_users_id_fk') THEN
    ALTER TABLE "sales_campaigns" ADD CONSTRAINT "sales_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_lead_events_lead_id_sales_leads_id_fk') THEN
    ALTER TABLE "sales_lead_events" ADD CONSTRAINT "sales_lead_events_lead_id_sales_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."sales_leads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_lead_events_created_by_users_id_fk') THEN
    ALTER TABLE "sales_lead_events" ADD CONSTRAINT "sales_lead_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code" ON "promo_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_codes_campaign" ON "promo_codes" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_org" ON "promo_redemptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_redemptions_code" ON "promo_redemptions" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_lead_events_lead" ON "sales_lead_events" USING btree ("lead_id","created_at");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_leads_campaign_id_sales_campaigns_id_fk') THEN
    ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_campaign_id_sales_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sales_campaigns"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_leads_campaign" ON "sales_leads" USING btree ("campaign_id");