-- Enum-Wert „portal“: Typ wird ersetzt statt ALTER TYPE … ADD VALUE, damit der neue Wert in derselben
-- Migrations-Transaktion (drizzle führt alle offenen Migrationen in EINER Transaktion aus) in 0017 nutzbar ist.
ALTER TYPE "public"."appointment_source" RENAME TO "appointment_source_old";--> statement-breakpoint
CREATE TYPE "public"."appointment_source" AS ENUM('manual', 'doctolib', 'online', 'phone', 'whatsapp', 'email', 'voice_agent', 'portal');--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "source" TYPE "public"."appointment_source" USING "source"::text::"public"."appointment_source";--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "source" SET DEFAULT 'manual';--> statement-breakpoint
DROP TYPE "public"."appointment_source_old";--> statement-breakpoint
CREATE TABLE "cash_closing_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cash_closing_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"closing_ref" text NOT NULL,
	"tss_serial" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"tss_serial" text NOT NULL,
	"tx_number" integer NOT NULL,
	"signature_counter" integer NOT NULL,
	"signature" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"process_type" text DEFAULT 'Kassenbeleg-V1' NOT NULL,
	"is_test" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_closings" ADD COLUMN "bons" jsonb;--> statement-breakpoint
ALTER TABLE "patient_links" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "service_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "dayparts" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "cash_closing_registrations" ADD CONSTRAINT "cash_closing_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closing_registrations" ADD CONSTRAINT "cash_closing_registrations_cash_closing_id_cash_closings_id_fk" FOREIGN KEY ("cash_closing_id") REFERENCES "public"."cash_closings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_transactions" ADD CONSTRAINT "fiscal_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_transactions" ADD CONSTRAINT "fiscal_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closing_registrations_closing" ON "cash_closing_registrations" USING btree ("cash_closing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_transactions_payment" ON "fiscal_transactions" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "fiscal_transactions_org" ON "fiscal_transactions" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "patient_links" ADD CONSTRAINT "patient_links_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_links_org_appointment" ON "patient_links" USING btree ("organization_id","appointment_id");