ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "service_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "service_date_to" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "service_date_fixed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Leistungsdatum/-zeitraum gehört zum Belegtext (§ 14 Abs. 4 Nr. 6 UStG) → nach dem Ausstellen ebenso unveränderbar (GoBD)
CREATE OR REPLACE FUNCTION podo_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  locked := OLD.status <> 'draft' OR OLD.number IS NOT NULL;
  IF TG_OP = 'DELETE' THEN
    IF locked THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen können nicht gelöscht werden (Storno verwenden).' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF locked THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (kein Zurücksetzen auf Entwurf).' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.net_cents IS DISTINCT FROM OLD.net_cents OR NEW.vat_cents IS DISTINCT FROM OLD.vat_cents
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.billing_contact_id IS DISTINCT FROM OLD.billing_contact_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.cancels_invoice_id IS DISTINCT FROM OLD.cancels_invoice_id
       OR NEW.service_date IS DISTINCT FROM OLD.service_date OR NEW.service_date_to IS DISTINCT FROM OLD.service_date_to
       OR NEW.service_date_fixed IS DISTINCT FROM OLD.service_date_fixed THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (Storno/Gutschrift verwenden).' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'Stornierte Rechnungen können nicht reaktiviert werden.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
