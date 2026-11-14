-- Beleg-Archiv (GoBD, § 14b UStG), Zahlungsbelege nach Ausstellung (§ 146a Abs. 2 AO, § 6 KassenSichV),
-- festgeschriebene Anrechnung von Teilbelegen (§ 14 Abs. 5 S. 2 UStG) und Momentaufnahme der Belegangaben.
-- Idempotent (mehrfach ausführbar): Tabellen/Spalten/Indizes mit IF NOT EXISTS, Constraints nur, wenn sie fehlen,
-- Policies/Trigger werden vorher entfernt, die Rückverknüpfung legt nur fehlende Zeilen an.
CREATE TABLE IF NOT EXISTS "document_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_receipt_id" uuid,
	"storage_key" text NOT NULL,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"retain_until" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"credited_invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "issued_snapshot" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_organization_id_organizations_id_fk') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_invoice_id_invoices_id_fk') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_payment_receipt_id_payment_receipts_id_fk') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_payment_receipt_id_payment_receipts_id_fk" FOREIGN KEY ("payment_receipt_id") REFERENCES "public"."payment_receipts"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_created_by_users_id_fk') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_credits_organization_id_organizations_id_fk') THEN
    ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_credits_invoice_id_invoices_id_fk') THEN
    ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_credits_credited_invoice_id_invoices_id_fk') THEN
    ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_credited_invoice_id_invoices_id_fk" FOREIGN KEY ("credited_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_receipts_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_receipts_invoice_id_invoices_id_fk') THEN
    ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_receipts_payment_id_payments_id_fk') THEN
    ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_receipts_created_by_users_id_fk') THEN
    ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  -- Wertebereiche
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_kind_check') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_kind_check" CHECK (
      (kind = 'invoice' AND payment_receipt_id IS NULL) OR (kind = 'payment_receipt' AND payment_receipt_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_archive_file_check') THEN
    ALTER TABLE "document_archive" ADD CONSTRAINT "document_archive_file_check" CHECK (
      mime = 'application/pdf' AND size_bytes > 0 AND sha256 ~ '^[0-9a-f]{64}$' AND length(storage_key) BETWEEN 1 AND 300
      AND filename ~ '^[A-Za-z0-9._-]{1,120}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_receipts_values_check') THEN
    ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_values_check" CHECK (
      method IN ('cash', 'card', 'voucher') AND amount_cents <> 0 AND number ~ '^ZB[0-9]{4}-[0-9]{4,}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_credits_values_check') THEN
    ALTER TABLE "invoice_credits" ADD CONSTRAINT "invoice_credits_values_check" CHECK (invoice_id <> credited_invoice_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_archive_invoice" ON "document_archive" USING btree ("invoice_id") WHERE "document_archive"."kind" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_archive_payment_receipt" ON "document_archive" USING btree ("payment_receipt_id") WHERE "document_archive"."kind" = 'payment_receipt';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_archive_org_invoice" ON "document_archive" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_credits_pair" ON "invoice_credits" USING btree ("invoice_id","credited_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_credits_org_invoice" ON "invoice_credits" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_credits_org_credited" ON "invoice_credits" USING btree ("organization_id","credited_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_receipts_payment" ON "payment_receipts" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_receipts_org_number" ON "payment_receipts" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_receipts_org_invoice" ON "payment_receipts" USING btree ("organization_id","invoice_id");
--> statement-breakpoint
-- Mandantentrennung (RLS + FORCE) wie bei allen Praxis-Tabellen
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_archive', 'invoice_credits', 'payment_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Unveränderbarkeit: archivierte Belege, Zahlungsbelege und Anrechnungen werden nur angelegt (GoBD). Gelöscht wird nur
-- mit der ganzen Praxis (Löschlauf als Eigentümer, src/server/purge-organization.ts schaltet die Trigger dafür ab).
CREATE OR REPLACE FUNCTION podo_append_only_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% ist unveränderbar (GoBD) und kann weder geändert noch gelöscht werden.',
    CASE TG_TABLE_NAME WHEN 'document_archive' THEN 'Das Beleg-Archiv'
                       WHEN 'payment_receipts' THEN 'Ein Zahlungsbeleg'
                       ELSE 'Die Anrechnung eines Teilbelegs' END
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_archive', 'invoice_credits', 'payment_receipts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION podo_append_only_document()', t || '_no_update', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Anlegen nur passend zur Praxis (FK-Prüfungen umgehen RLS, daher hier explizit):
-- Anrechnung: Endrechnung (Rechnung/Sammelrechnung) und Teilbeleg (Anzahlung/Quittung) derselben Praxis und Person,
-- Betrag = Gesamtbetrag des Teilbelegs; der Teilbeleg ist gerade auf diese Rechnung angerechnet (collective_invoice_id)
-- oder die Rechnung ist bereits storniert (Rückverknüpfung von Altbeständen aus der Stornorechnung).
CREATE OR REPLACE FUNCTION podo_invoice_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i invoices%ROWTYPE;
  c invoices%ROWTYPE;
BEGIN
  SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
  SELECT * INTO c FROM invoices WHERE id = NEW.credited_invoice_id;
  IF i.id IS NULL OR c.id IS NULL OR i.organization_id <> NEW.organization_id OR c.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Anrechnung: Beleg nicht gefunden.' USING ERRCODE = 'P0001';
  END IF;
  IF i.kind NOT IN ('invoice', 'collective') OR c.kind NOT IN ('deposit', 'receipt') OR i.patient_id IS DISTINCT FROM c.patient_id THEN
    RAISE EXCEPTION 'Anrechnung nur von Anzahlungen/Quittungen derselben Person auf eine Rechnung/Sammelrechnung.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.amount_cents <> c.total_cents THEN
    RAISE EXCEPTION 'Anrechnung: Betrag passt nicht zum Teilbeleg.' USING ERRCODE = 'P0001';
  END IF;
  IF c.collective_invoice_id IS DISTINCT FROM NEW.invoice_id AND i.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Anrechnung: Der Teilbeleg ist nicht auf diese Rechnung angerechnet.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_credits_insert_guard ON invoice_credits;
--> statement-breakpoint
CREATE TRIGGER invoice_credits_insert_guard BEFORE INSERT ON invoice_credits
  FOR EACH ROW EXECUTE FUNCTION podo_invoice_credit_guard();
--> statement-breakpoint
-- Zahlungsbeleg: Zahlung derselben Praxis und Rechnung, Betrag/Zahlart wie die Zahlung (nur Kassenvorgänge, siehe
-- payment_receipts_values_check); created_by NULL = vom System (z. B. SumUp-Webhook)
CREATE OR REPLACE FUNCTION podo_payment_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
  IF p.id IS NULL OR p.organization_id <> NEW.organization_id OR p.invoice_id <> NEW.invoice_id THEN
    RAISE EXCEPTION 'Zahlungsbeleg gehört zu keiner Zahlung dieser Praxis/Rechnung.' USING ERRCODE = 'P0001';
  END IF;
  IF p.amount_cents <> NEW.amount_cents OR p.method::text <> NEW.method THEN
    RAISE EXCEPTION 'Zahlungsbeleg: Betrag oder Zahlart passt nicht zur Zahlung.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_receipts_insert_guard ON payment_receipts;
--> statement-breakpoint
CREATE TRIGGER payment_receipts_insert_guard BEFORE INSERT ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION podo_payment_receipt_guard();
--> statement-breakpoint
-- Archiv: nur ausgestellte Belege derselben Praxis (keine Entwürfe); Zahlungsbeleg zur selben Rechnung
CREATE OR REPLACE FUNCTION podo_document_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i invoices%ROWTYPE;
BEGIN
  SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
  IF i.id IS NULL OR i.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Beleg-Archiv: Rechnung nicht gefunden.' USING ERRCODE = 'P0001';
  END IF;
  IF i.status = 'draft' OR i.number IS NULL THEN
    RAISE EXCEPTION 'Beleg-Archiv: Entwürfe werden nicht archiviert.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.payment_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_receipts r WHERE r.id = NEW.payment_receipt_id AND r.organization_id = NEW.organization_id AND r.invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'Beleg-Archiv: Zahlungsbeleg gehört nicht zu dieser Rechnung.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_archive_insert_guard ON document_archive;
--> statement-breakpoint
CREATE TRIGGER document_archive_insert_guard BEFORE INSERT ON document_archive
  FOR EACH ROW EXECUTE FUNCTION podo_document_archive_guard();
--> statement-breakpoint
-- Rechnungen: die Momentaufnahme der Belegangaben (issued_snapshot) wird nur beim Ausstellen gesetzt und ist danach
-- wie Nummer, Beträge und Leistungsdatum unveränderbar (Stand 0038 + issued_snapshot)
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
       OR NEW.service_date_fixed IS DISTINCT FROM OLD.service_date_fixed
       OR NEW.issued_snapshot IS DISTINCT FROM OLD.issued_snapshot THEN
      RAISE EXCEPTION 'Ausgestellte Rechnungen sind unveränderbar (Storno/Gutschrift verwenden).' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'Stornierte Rechnungen können nicht reaktiviert werden.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Rückverknüpfung der Anrechnungen (Bestand): 1) aktuell angerechnete Teilbelege, 2) Teilbelege stornierter Rechnungen
-- aus den Vermerken der Stornorechnung („[intern] Angerechnete Quittungen/Anzahlungen: …“ bzw. der ältere Satz
-- „Angerechnete Anzahlungen (…) bleiben gültig …“). RLS ist auch für den Eigentümer erzwungen → je Praxis app.org_id.
DO $$
DECLARE
  o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    INSERT INTO invoice_credits (organization_id, invoice_id, credited_invoice_id, amount_cents)
    SELECT c.organization_id, c.collective_invoice_id, c.id, c.total_cents
      FROM invoices c
      JOIN invoices i ON i.id = c.collective_invoice_id AND i.organization_id = c.organization_id
     WHERE c.organization_id = o.id AND c.kind IN ('deposit', 'receipt') AND i.kind IN ('invoice', 'collective')
       AND i.patient_id IS NOT DISTINCT FROM c.patient_id
    ON CONFLICT (invoice_id, credited_invoice_id) DO NOTHING;

    INSERT INTO invoice_credits (organization_id, invoice_id, credited_invoice_id, amount_cents)
    SELECT DISTINCT orig.organization_id, orig.id, part.id, part.total_cents
      FROM invoices cn
      JOIN invoices orig ON orig.id = cn.cancels_invoice_id AND orig.organization_id = cn.organization_id
      CROSS JOIN LATERAL (
        SELECT trim(n) AS num
          FROM unnest(string_to_array(coalesce(cn.notes, ''), E'\n')) WITH ORDINALITY AS l(line, pos)
          CROSS JOIN LATERAL unnest(string_to_array(
            CASE
              WHEN l.line LIKE '[intern] Angerechnete Quittungen: %' THEN substr(l.line, length('[intern] Angerechnete Quittungen: ') + 1)
              WHEN l.line LIKE '[intern] Angerechnete Anzahlungen: %' THEN substr(l.line, length('[intern] Angerechnete Anzahlungen: ') + 1)
              WHEN l.line ~ '^Angerechnete (Anzahlungen|Quittungen) \(.*\) bleiben' THEN substring(l.line FROM '^Angerechnete (?:Anzahlungen|Quittungen) \((.*)\) bleiben')
              ELSE ''
            END, ',')) AS n
         WHERE l.pos > 1
      ) nums
      JOIN invoices part ON part.organization_id = cn.organization_id AND part.number = nums.num AND part.kind IN ('deposit', 'receipt')
     WHERE cn.organization_id = o.id AND cn.kind = 'credit_note' AND orig.status = 'cancelled'
       AND orig.kind IN ('invoice', 'collective') AND part.patient_id IS NOT DISTINCT FROM orig.patient_id AND nums.num <> ''
    ON CONFLICT (invoice_id, credited_invoice_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;
