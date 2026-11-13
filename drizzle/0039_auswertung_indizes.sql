-- Idempotent (nur CREATE INDEX IF NOT EXISTS) – darf bei Umnummerierung erneut laufen.
-- Auswertung & Statistik: erster Termin je Person, Positionen je Beleg, Rechnungs- und Zahlungsdatum je Praxis.
CREATE INDEX IF NOT EXISTS "appointments_org_patient" ON "appointments" USING btree ("organization_id","patient_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_lines_invoice" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_org_issued" ON "invoices" USING btree ("organization_id","issued_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_org_paid" ON "payments" USING btree ("organization_id","paid_at");
