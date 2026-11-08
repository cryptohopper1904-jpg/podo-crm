DROP INDEX "webhook_events_idem";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "treatment_record_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_treatment_record_id_treatment_records_id_fk" FOREIGN KEY ("treatment_record_id") REFERENCES "public"."treatment_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_links_one_active" ON "patient_links" USING btree ("organization_id","patient_id","purpose") WHERE "patient_links"."revoked_at" is null and "patient_links"."used_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_idem_org" ON "webhook_events" USING btree ("provider","organization_id","external_id");