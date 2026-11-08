CREATE TABLE "cash_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"business_date" date NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"opening_cents" integer NOT NULL,
	"cash_payments_cents" integer NOT NULL,
	"movements_cents" integer NOT NULL,
	"expected_cash_cents" integer NOT NULL,
	"counted_cash_cents" integer NOT NULL,
	"difference_cents" integer NOT NULL,
	"denominations" jsonb NOT NULL,
	"totals" jsonb NOT NULL,
	"payment_count" integer NOT NULL,
	"movement_count" integer NOT NULL,
	"first_bon_nr" integer NOT NULL,
	"last_bon_nr" integer NOT NULL,
	"items_digest" text NOT NULL,
	"tse" jsonb NOT NULL,
	"difference_reason" text,
	"note" text,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cash_closing_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cash_closing_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_closings" ADD CONSTRAINT "cash_closings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closings" ADD CONSTRAINT "cash_closings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_cash_closing_id_cash_closings_id_fk" FOREIGN KEY ("cash_closing_id") REFERENCES "public"."cash_closings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closings_org_number" ON "cash_closings" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closings_org_date" ON "cash_closings" USING btree ("organization_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_movements_org_closing" ON "cash_movements" USING btree ("organization_id","cash_closing_id","occurred_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_closing_id_cash_closings_id_fk" FOREIGN KEY ("cash_closing_id") REFERENCES "public"."cash_closings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_org_closing" ON "payments" USING btree ("organization_id","cash_closing_id","paid_at");