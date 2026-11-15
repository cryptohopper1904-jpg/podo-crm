-- Idempotent (IF NOT EXISTS) – darf bei Umnummerierung erneut laufen. Indizes für den Abrechnungsstand je Termin
-- (src/server/appointment-invoiced.ts: Zieh-/Verschiebe-Sperre, R-Symbol) und die Doppelabrechnungs-Prüfung
-- (assertNotInvoiced): Doku-Einträge zu Terminen und Rechnungspositionen zu Doku-Einträgen, jeweils je Praxis.
CREATE INDEX IF NOT EXISTS "invoice_lines_treatment_record" ON "invoice_lines" USING btree ("organization_id","treatment_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treatment_records_appointment" ON "treatment_records" USING btree ("organization_id","appointment_id");
