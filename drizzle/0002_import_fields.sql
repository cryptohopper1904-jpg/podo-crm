ALTER TABLE "invoices" ADD COLUMN "collective_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source" text DEFAULT 'crm' NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "extra" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "opening_redeemed_cents" integer DEFAULT 0 NOT NULL;