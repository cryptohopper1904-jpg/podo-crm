CREATE TABLE "sales_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_person" text,
	"email" text,
	"phone" text,
	"website" text,
	"street" text,
	"zip" text,
	"city" text,
	"distance_km" double precision,
	"source" text,
	"notes" text,
	"status" text DEFAULT 'neu' NOT NULL,
	"step" smallint DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"step" smallint NOT NULL,
	"ok" boolean NOT NULL,
	"mock" boolean DEFAULT false NOT NULL,
	"message_id" text,
	"error" text,
	"sent_by" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"sender_name" text DEFAULT '' NOT NULL,
	"sender_email" text DEFAULT '' NOT NULL,
	"reply_to" text DEFAULT '' NOT NULL,
	"impressum" text DEFAULT '' NOT NULL,
	"delay2_days" smallint DEFAULT 5 NOT NULL,
	"delay3_days" smallint DEFAULT 10 NOT NULL,
	"templates" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_sends" ADD CONSTRAINT "sales_sends_lead_id_sales_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."sales_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sends" ADD CONSTRAINT "sales_sends_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_leads_email" ON "sales_leads" USING btree (lower("email")) WHERE "sales_leads"."email" is not null;--> statement-breakpoint
CREATE INDEX "sales_leads_status" ON "sales_leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sales_sends_lead" ON "sales_sends" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "sales_sends_sent_at" ON "sales_sends" USING btree ("sent_at");