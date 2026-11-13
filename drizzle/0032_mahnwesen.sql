CREATE TABLE "invoice_dunnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"letter_date" date NOT NULL,
	"pay_by" date NOT NULL,
	"open_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"fees_total_cents" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"sent_via" text,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_dunnings" ADD CONSTRAINT "invoice_dunnings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_dunnings" ADD CONSTRAINT "invoice_dunnings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_dunnings" ADD CONSTRAINT "invoice_dunnings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_dunnings_invoice_stage" ON "invoice_dunnings" USING btree ("invoice_id","stage");--> statement-breakpoint
CREATE INDEX "invoice_dunnings_org_invoice" ON "invoice_dunnings" USING btree ("organization_id","invoice_id");