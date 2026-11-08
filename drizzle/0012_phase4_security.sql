-- Phase 4: eVerordnung/OCR-Herkunft absichern
-- Eine eVerordnung (TI-Referenz) darf je Praxis nur einmal importiert werden
CREATE UNIQUE INDEX IF NOT EXISTS "prescriptions_external_ref_org" ON "prescriptions" ("organization_id", "external_ref") WHERE "external_ref" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_source_check" CHECK ("source" IN ('paper', 'ocr', 'everordnung'));
