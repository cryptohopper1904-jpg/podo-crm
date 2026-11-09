CREATE TABLE "geocode_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"address_hash" text NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"provider" text NOT NULL,
	"distance_m" integer NOT NULL,
	"duration_sec" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"distance_m" integer,
	"duration_sec" integer,
	"purpose" text,
	"odometer_start" integer,
	"odometer_end" integer,
	"arrived_at" timestamp with time zone,
	"voided" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_start_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"street" text,
	"zip" text,
	"city" text,
	"lat" double precision,
	"lon" double precision,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"driver_id" uuid,
	"trip_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_label" text NOT NULL,
	"to_label" text NOT NULL,
	"purpose" text DEFAULT 'Hausbesuch' NOT NULL,
	"distance_m" integer NOT NULL,
	"duration_sec" integer,
	"distance_source" text NOT NULL,
	"provider" text,
	"appointment_id" uuid,
	"vehicle_label" text,
	"plate" text,
	"odometer_start" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geocode_cache" ADD CONSTRAINT "geocode_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_cache" ADD CONSTRAINT "route_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_corrections" ADD CONSTRAINT "trip_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_corrections" ADD CONSTRAINT "trip_corrections_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_corrections" ADD CONSTRAINT "trip_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_start_locations" ADD CONSTRAINT "trip_start_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geocode_cache_org_address" ON "geocode_cache" USING btree ("organization_id","address_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "route_cache_org_key" ON "route_cache" USING btree ("organization_id","key_hash");--> statement-breakpoint
CREATE INDEX "trip_corrections_trip" ON "trip_corrections" USING btree ("organization_id","trip_id");--> statement-breakpoint
CREATE INDEX "trip_start_locations_org" ON "trip_start_locations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_start_locations_one_default" ON "trip_start_locations" USING btree ("organization_id") WHERE "trip_start_locations"."is_default" and "trip_start_locations"."active";--> statement-breakpoint
CREATE INDEX "trips_org_date" ON "trips" USING btree ("organization_id","trip_date");--> statement-breakpoint
CREATE INDEX "trips_org_appointment" ON "trips" USING btree ("organization_id","appointment_id");