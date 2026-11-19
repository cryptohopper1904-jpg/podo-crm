-- GKV Paket E: neutrales Übergabepaket an ein beliebiges Abrechnungszentrum, Archiv und Rückmeldung (Auszahlungen).
--
-- 1. billing_batch_exports: Archiv des beim ersten Export erzeugten Übergabepakets (ZIP) je Abrechnungslauf – verschlüsselt
--    in der Dateiablage (storage_key, AES-256-GCM je Praxis), SHA-256 des Klartexts, Größe, Dateiname, Format-Version.
--    Ein erneuter Download liefert genau diese Datei („Nachdruck“; offene Fachfrage 37/GoBD). Je Lauf und Art höchstens
--    ein Eintrag; append-only (kein UPDATE/DELETE/TRUNCATE – Trigger, zusätzlich REVOKE in scripts/migrate.ts); created_at
--    und after_first_handover (Lauf war beim Archivieren schon übergeben = Archiv ist nicht die Erstübergabe, Export vor
--    Paket E) setzt der Trigger, nie die Anwendung. Speicherschlüssel nur aus dem Bereich der eigenen Praxis.
-- 2. billing_batch_payouts: Auszahlung des Abrechnungszentrums zu einem übergebenen Lauf (aus einer eingelesenen
--    Rückmeldung – Datei als Beleg verschlüsselt abgelegt, Prüfsumme; dieselbe Datei je Lauf nur einmal aktiv – oder von
--    Hand), mit optional einbehaltener Gebühr. Append-only; Korrektur nur als Storno (Gegenbuchung source = reversal,
--    exakt negative Beträge, Pflichtbegründung, höchstens ein Storno je Auszahlung, Storno nicht stornierbar).
--    Nur zu einem übergebenen Lauf (exported_at gesetzt); created_at vom Trigger.
-- 3. gkv_deductions.payout_id: Absetzung aus einer Rückmeldung; unveränderlich, nur zu einer Auszahlung desselben Laufs
--    der Praxis (podo_gkv_deduction_guard, zuletzt 0066).
-- Keine Personen-Spalten: Archiv und Auszahlungen hängen am Lauf (Abrechnungsunterlage). Personen mit abgerechneten
-- Verordnungen sind ohnehin nicht vollständig löschbar (podo_delete_patient) – keine Änderung dort. Löschen nur mit der
-- Praxis (Löschlauf als Eigentümer schaltet Trigger ab, src/server/purge-organization.ts).
-- Verweise nur innerhalb der Praxis (podo_fk_same_org, podo_user_in_org), RLS + FORCE (USING + WITH CHECK), Prüfungen in
-- Triggern lesen unter RLS (fehlender/fremder Praxis-Kontext → Lauf „nicht gefunden“ → Ablehnung, nie leer durchgelassen).
-- Alle Funktionen mit festem search_path, REVOKE ALL FROM PUBLIC.
-- Idempotent: IF NOT EXISTS, Constraints nur wenn fehlend, CREATE OR REPLACE, DROP TRIGGER/POLICY IF EXISTS.
CREATE TABLE IF NOT EXISTS "billing_batch_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"filename" text NOT NULL,
	"schema_version" text NOT NULL,
	"prescription_count" integer NOT NULL,
	"after_first_handover" boolean DEFAULT false NOT NULL,
	"missing_documents" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_batch_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_batch_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"deduction_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" date NOT NULL,
	"reference" text,
	"source" text NOT NULL,
	"source_sha256" text,
	"import_seq" integer,
	"storage_key" text,
	"source_filename" text,
	"reverses_payout_id" uuid,
	"reason" text,
	"line_count" integer DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Spalten der Nachbesserung (Storno, Gebühr, Beleg der Rückmeldung, fehlende Dokumente) – auch für eine früher eingespielte Fassung
ALTER TABLE "billing_batch_exports" ADD COLUMN IF NOT EXISTS "missing_documents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "import_seq" integer;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "source_filename" text;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "reverses_payout_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_batch_payouts" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "gkv_deductions" ADD COLUMN IF NOT EXISTS "payout_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_exports_organization_id_organizations_id_fk') THEN
    ALTER TABLE "billing_batch_exports" ADD CONSTRAINT "billing_batch_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_exports_billing_batch_id_billing_batches_id_fk') THEN
    ALTER TABLE "billing_batch_exports" ADD CONSTRAINT "billing_batch_exports_billing_batch_id_billing_batches_id_fk" FOREIGN KEY ("billing_batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_exports_created_by_users_id_fk') THEN
    ALTER TABLE "billing_batch_exports" ADD CONSTRAINT "billing_batch_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_payouts_organization_id_organizations_id_fk') THEN
    ALTER TABLE "billing_batch_payouts" ADD CONSTRAINT "billing_batch_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_payouts_billing_batch_id_billing_batches_id_fk') THEN
    ALTER TABLE "billing_batch_payouts" ADD CONSTRAINT "billing_batch_payouts_billing_batch_id_billing_batches_id_fk" FOREIGN KEY ("billing_batch_id") REFERENCES "public"."billing_batches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_batch_payouts_created_by_users_id_fk') THEN
    ALTER TABLE "billing_batch_payouts" ADD CONSTRAINT "billing_batch_payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = left('billing_batch_payouts_reverses_payout_id_billing_batch_payouts_id_fk', 63)) THEN
    ALTER TABLE "billing_batch_payouts" ADD CONSTRAINT "billing_batch_payouts_reverses_payout_id_billing_batch_payouts_id_fk" FOREIGN KEY ("reverses_payout_id") REFERENCES "public"."billing_batch_payouts"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gkv_deductions_payout_id_billing_batch_payouts_id_fk') THEN
    ALTER TABLE "gkv_deductions" ADD CONSTRAINT "gkv_deductions_payout_id_billing_batch_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."billing_batch_payouts"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  ALTER TABLE billing_batch_exports DROP CONSTRAINT IF EXISTS billing_batch_exports_values_check;
  ALTER TABLE billing_batch_exports ADD CONSTRAINT billing_batch_exports_values_check CHECK (
    kind = 'handover_zip' AND sha256 ~ '^[0-9a-f]{64}$' AND size_bytes > 0 AND prescription_count >= 0 AND missing_documents >= 0
    AND length(filename) BETWEEN 1 AND 200 AND length(schema_version) BETWEEN 1 AND 60 AND length(storage_key) <= 300);
  -- Auszahlung (import/manual): Beträge ≥ 0; Storno (reversal): Gegenbuchung ≤ 0 mit Begründung, Bezug und ohne Datei –
  -- Gleichheit mit dem Original prüft der Trigger. Import: Prüfsumme, Datei (Beleg) und laufende Nummer je Datei.
  ALTER TABLE billing_batch_payouts DROP CONSTRAINT IF EXISTS billing_batch_payouts_values_check;
  ALTER TABLE billing_batch_payouts ADD CONSTRAINT billing_batch_payouts_values_check CHECK (
    source IN ('import', 'manual', 'reversal')
    AND (CASE WHEN source = 'reversal'
          THEN amount_cents BETWEEN -100000000 AND 0 AND deduction_cents BETWEEN -100000000 AND 0 AND fee_cents BETWEEN -100000000 AND 0
               AND reverses_payout_id IS NOT NULL AND reason IS NOT NULL AND char_length(reason) BETWEEN 5 AND 500
               AND line_count = 0 AND details = '[]'::jsonb
          ELSE amount_cents BETWEEN 0 AND 100000000 AND deduction_cents BETWEEN 0 AND 100000000 AND fee_cents BETWEEN 0 AND 100000000
               AND reverses_payout_id IS NULL AND (reason IS NULL OR char_length(reason) <= 500) END)
    AND (source = 'import') = (source_sha256 IS NOT NULL)
    AND (source = 'import') = (storage_key IS NOT NULL)
    AND (source = 'import') = (import_seq IS NOT NULL)
    AND (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$')
    AND (storage_key IS NULL OR length(storage_key) <= 300)
    AND (source_filename IS NULL OR length(source_filename) <= 200)
    AND (reference IS NULL OR length(reference) BETWEEN 1 AND 60)
    AND line_count BETWEEN 0 AND 10000 AND jsonb_typeof(details) = 'array' AND jsonb_array_length(details) <= 10000
    AND paid_at >= DATE '2000-01-01');
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_batch_exports_batch_kind" ON "billing_batch_exports" USING btree ("billing_batch_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_batch_payouts_org_id" ON "billing_batch_payouts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_batch_payouts_org_batch" ON "billing_batch_payouts" USING btree ("organization_id","billing_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_batch_payouts_org_paid" ON "billing_batch_payouts" USING btree ("organization_id","paid_at");--> statement-breakpoint
-- dieselbe Datei je Lauf nur einmal aktiv: laufende Nummer je (Lauf, Prüfsumme), vom Trigger gesetzt (erneut nur nach Storno)
DROP INDEX IF EXISTS "billing_batch_payouts_source";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_batch_payouts_source" ON "billing_batch_payouts" USING btree ("billing_batch_id","source_sha256","import_seq") WHERE "billing_batch_payouts"."source_sha256" is not null;--> statement-breakpoint
-- höchstens ein Storno je Auszahlung
CREATE UNIQUE INDEX IF NOT EXISTS "billing_batch_payouts_reverses" ON "billing_batch_payouts" USING btree ("reverses_payout_id") WHERE "billing_batch_payouts"."reverses_payout_id" is not null;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_batch_exports', 'billing_batch_payouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Archiv des Übergabepakets: nur anlegen, nur zu einem übergebenen Lauf (die App vermerkt die Übergabe zuerst, AppSec H3).
-- Zeitpunkt und „nach Erstübergabe“ (Übergabe in einem früheren Vorgang) vom Server; Lauf der eigenen Praxis (unter RLS
-- gelesen – ohne passenden Praxis-Kontext nicht gefunden → Ablehnung); Datei aus dem Speicherbereich der Praxis.
CREATE OR REPLACE FUNCTION podo_billing_batch_export_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE exported timestamptz; found_batch boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Das archivierte Übergabepaket ist unveränderlich und kann nicht gelöscht werden (Abrechnungsunterlage).' USING ERRCODE = 'P0001';
  END IF;
  IF current_setting('app.org_id', true) IS DISTINCT FROM NEW.organization_id::text THEN
    RAISE EXCEPTION 'Übergabepaket nur im Praxis-Kontext der eigenen Praxis.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.storage_key IS NULL OR left(NEW.storage_key, 37) IS DISTINCT FROM NEW.organization_id::text || '/' OR position('..' IN NEW.storage_key) > 0 THEN
    RAISE EXCEPTION 'Speicherschlüssel gehört nicht zur Praxis.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT true, b.exported_at INTO found_batch, exported FROM billing_batches b
   WHERE b.id = NEW.billing_batch_id AND b.organization_id = NEW.organization_id;
  IF found_batch IS NULL THEN
    RAISE EXCEPTION 'Abrechnungslauf nicht gefunden.' USING ERRCODE = 'check_violation';
  END IF;
  IF exported IS NULL THEN
    RAISE EXCEPTION 'Übergabepaket nur zu einem übergebenen Abrechnungslauf.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.after_first_handover := exported < now();
  NEW.created_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_billing_batch_export_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_exports_guard ON billing_batch_exports;
--> statement-breakpoint
CREATE TRIGGER billing_batch_exports_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_batch_exports
  FOR EACH ROW EXECUTE FUNCTION podo_billing_batch_export_guard();
--> statement-breakpoint
-- Auszahlung: nur anlegen, nur zu einem übergebenen Lauf der eigenen Praxis; Zeitpunkt vom Server.
-- Import: Datei im Speicherbereich der Praxis; dieselbe Datei (Prüfsumme) je Lauf nur, wenn alle früheren Importe dieser
-- Datei storniert sind – laufende Nummer import_seq (eindeutiger Index fängt gleichzeitige Importe).
-- Storno (reversal): Gegenbuchung zu einer Auszahlung desselben Laufs, die selbst kein Storno ist; Beträge exakt negativ;
-- höchstens ein Storno je Auszahlung (eindeutiger Index).
CREATE OR REPLACE FUNCTION podo_billing_batch_payout_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o record; n int; active int;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Eine erfasste Auszahlung ist unveränderlich und kann nicht gelöscht werden (Abrechnungsunterlage).' USING ERRCODE = 'P0001';
  END IF;
  IF current_setting('app.org_id', true) IS DISTINCT FROM NEW.organization_id::text THEN
    RAISE EXCEPTION 'Auszahlung nur im Praxis-Kontext der eigenen Praxis.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_batches b
                  WHERE b.id = NEW.billing_batch_id AND b.organization_id = NEW.organization_id AND b.exported_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Auszahlungen gibt es nur zu einem übergebenen Abrechnungslauf.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.storage_key IS NOT NULL AND (left(NEW.storage_key, 37) IS DISTINCT FROM NEW.organization_id::text || '/' OR position('..' IN NEW.storage_key) > 0) THEN
    RAISE EXCEPTION 'Speicherschlüssel gehört nicht zur Praxis.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source = 'import' THEN
    SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM billing_batch_payouts r WHERE r.reverses_payout_id = p.id))
      INTO n, active
      FROM billing_batch_payouts p
     WHERE p.billing_batch_id = NEW.billing_batch_id AND p.organization_id = NEW.organization_id
       AND p.source = 'import' AND p.source_sha256 = NEW.source_sha256;
    IF active > 0 THEN
      RAISE EXCEPTION 'Diese Rückmeldung ist für diesen Abrechnungslauf bereits eingelesen.' USING ERRCODE = 'unique_violation', CONSTRAINT = 'billing_batch_payouts_source';
    END IF;
    NEW.import_seq := n + 1;
  END IF;
  IF NEW.source = 'reversal' THEN
    SELECT p.billing_batch_id, p.source, p.amount_cents, p.deduction_cents, p.fee_cents INTO o
      FROM billing_batch_payouts p WHERE p.id = NEW.reverses_payout_id AND p.organization_id = NEW.organization_id;
    IF o IS NULL OR o.billing_batch_id IS DISTINCT FROM NEW.billing_batch_id OR o.source = 'reversal'
       OR NEW.amount_cents IS DISTINCT FROM -o.amount_cents OR NEW.deduction_cents IS DISTINCT FROM -o.deduction_cents
       OR NEW.fee_cents IS DISTINCT FROM -o.fee_cents THEN
      RAISE EXCEPTION 'Storno passt nicht zur Auszahlung (gleicher Lauf, kein Storno eines Stornos, Beträge exakt negativ).' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_billing_batch_payout_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_payouts_guard ON billing_batch_payouts;
--> statement-breakpoint
CREATE TRIGGER billing_batch_payouts_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_batch_payouts
  FOR EACH ROW EXECUTE FUNCTION podo_billing_batch_payout_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION podo_no_truncate_gkv_handover() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Archivierte Übergabepakete und Auszahlungen können nicht geleert werden.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_no_truncate_gkv_handover() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_exports_no_truncate ON billing_batch_exports;
--> statement-breakpoint
CREATE TRIGGER billing_batch_exports_no_truncate BEFORE TRUNCATE ON billing_batch_exports
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_handover();
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_payouts_no_truncate ON billing_batch_payouts;
--> statement-breakpoint
CREATE TRIGGER billing_batch_payouts_no_truncate BEFORE TRUNCATE ON billing_batch_payouts
  FOR EACH STATEMENT EXECUTE FUNCTION podo_no_truncate_gkv_handover();
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_exports_fk_same_org ON billing_batch_exports;
--> statement-breakpoint
CREATE TRIGGER billing_batch_exports_fk_same_org BEFORE INSERT OR UPDATE OF billing_batch_id, organization_id ON billing_batch_exports
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('billing_batch_id', 'billing_batches');
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_payouts_fk_same_org ON billing_batch_payouts;
--> statement-breakpoint
CREATE TRIGGER billing_batch_payouts_fk_same_org BEFORE INSERT OR UPDATE OF billing_batch_id, reverses_payout_id, organization_id ON billing_batch_payouts
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('billing_batch_id', 'billing_batches', 'reverses_payout_id', 'billing_batch_payouts');
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_exports_user_in_org ON billing_batch_exports;
--> statement-breakpoint
CREATE TRIGGER billing_batch_exports_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON billing_batch_exports
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_batch_payouts_user_in_org ON billing_batch_payouts;
--> statement-breakpoint
CREATE TRIGGER billing_batch_payouts_user_in_org BEFORE INSERT OR UPDATE OF created_by, organization_id ON billing_batch_payouts
  FOR EACH ROW EXECUTE FUNCTION podo_user_in_org('created_by', 'actor');
--> statement-breakpoint
-- Absetzungen (zuletzt 0066): zusätzlich payout_id – unveränderlich; beim Anlegen nur zu einer eingelesenen Rückmeldung
-- (source = import, nie Storno oder Handeingabe, AppSec N1) desselben Laufs der Praxis (unter RLS gelesen). Mit Lauf: die Verordnung gehört zu diesem Lauf (billing_batch_id oder Lauf der
-- Erstabrechnung eines Korrekturvermerks, AppSec H3). Sonst unverändert.
CREATE OR REPLACE FUNCTION podo_gkv_deduction_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE vo_patient uuid; vo_status text; vo_billed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF podo_owner_delete_allowed(TG_RELID, OLD.patient_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Eine Absetzung kann nicht gelöscht werden (Aufbewahrung) – bitte den Status ändern.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prescription_id IS DISTINCT FROM OLD.prescription_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.billing_batch_id IS DISTINCT FROM OLD.billing_batch_id
       OR NEW.payout_id IS DISTINCT FROM OLD.payout_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Bezug der Absetzung ist unveränderlich.' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'open' AND (NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.deducted_on IS DISTINCT FROM OLD.deducted_on) THEN
      RAISE EXCEPTION 'Betrag, Grund und Datum sind nur bei offenen Absetzungen änderbar.' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status = 'done' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Die Absetzung ist erledigt und damit abgeschlossen.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.patient_id, p.status, p.billed_at INTO vo_patient, vo_status, vo_billed FROM prescriptions p
   WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id;
  IF vo_patient IS NULL OR vo_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Absetzung passt nicht zur Verordnung.' USING ERRCODE = 'P0001';
  END IF;
  IF vo_billed IS NULL AND vo_status NOT IN ('billed', 'correction_needed') THEN
    RAISE EXCEPTION 'Absetzungen gibt es nur zu abgerechneten Verordnungen.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.billing_batch_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = NEW.prescription_id AND p.organization_id = NEW.organization_id
                       AND p.billing_batch_id = NEW.billing_batch_id)
     AND NOT EXISTS (SELECT 1 FROM prescription_corrections pc WHERE pc.prescription_id = NEW.prescription_id
                       AND pc.organization_id = NEW.organization_id AND pc.original_batch_id = NEW.billing_batch_id) THEN
    RAISE EXCEPTION 'Die Verordnung gehört nicht zu diesem Abrechnungslauf.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.payout_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM billing_batch_payouts bp
        WHERE bp.id = NEW.payout_id AND bp.organization_id = NEW.organization_id AND bp.source = 'import'
          AND bp.billing_batch_id IS NOT DISTINCT FROM NEW.billing_batch_id) THEN
    RAISE EXCEPTION 'Absetzung passt nicht zur Rückmeldung (Auszahlung desselben Abrechnungslaufs).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION podo_gkv_deduction_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gkv_deductions_fk_same_org ON gkv_deductions;
--> statement-breakpoint
CREATE TRIGGER gkv_deductions_fk_same_org BEFORE INSERT OR UPDATE OF prescription_id, patient_id, billing_batch_id, payout_id, organization_id ON gkv_deductions
  FOR EACH ROW EXECUTE FUNCTION podo_fk_same_org('prescription_id', 'prescriptions', 'patient_id', 'patients', 'billing_batch_id', 'billing_batches', 'payout_id', 'billing_batch_payouts');
--> statement-breakpoint
COMMENT ON TABLE billing_batch_exports IS
  'Archiv des neutralen Übergabepakets je Abrechnungslauf (verschlüsselte Datei, SHA-256) – append-only, GKV Paket E, Migration 0068.';
--> statement-breakpoint
COMMENT ON TABLE billing_batch_payouts IS
  'Auszahlung des Abrechnungszentrums zu einem übergebenen Abrechnungslauf (Rückmeldung oder von Hand) – append-only, GKV Paket E, Migration 0068.';
