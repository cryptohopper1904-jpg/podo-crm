ALTER TYPE "public"."channel" ADD VALUE 'kim';--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "source" text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "import_data" jsonb;