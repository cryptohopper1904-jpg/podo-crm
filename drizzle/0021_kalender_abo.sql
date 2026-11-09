ALTER TYPE "public"."appointment_source" ADD VALUE 'extern';--> statement-breakpoint
CREATE TABLE "calendar_feed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"appointment_id" uuid,
	"hash" text NOT NULL,
	"applied_hash" text NOT NULL,
	"conflict" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url_enc" text NOT NULL,
	"url_hint" text NOT NULL,
	"therapist_id" uuid,
	"source" "appointment_source" DEFAULT 'doctolib' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_sync_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_feed_events" ADD CONSTRAINT "calendar_feed_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_events" ADD CONSTRAINT "calendar_feed_events_feed_id_calendar_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."calendar_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_events" ADD CONSTRAINT "calendar_feed_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_therapist_id_users_id_fk" FOREIGN KEY ("therapist_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_events_key" ON "calendar_feed_events" USING btree ("feed_id","event_key");--> statement-breakpoint
CREATE INDEX "calendar_feed_events_appointment" ON "calendar_feed_events" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "calendar_feeds_org" ON "calendar_feeds" USING btree ("organization_id");