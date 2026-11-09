ALTER TYPE "public"."invoice_kind" ADD VALUE 'deposit';--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_appointment" ON "invoice_lines" USING btree ("organization_id","appointment_id");--> statement-breakpoint
CREATE INDEX "invoices_org_collective" ON "invoices" USING btree ("organization_id","collective_invoice_id");