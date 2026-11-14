-- Idempotent (IF NOT EXISTS / DROP … IF EXISTS / ON CONFLICT) – darf erneut laufen.
-- Eigene Leistungs-Kategorien je Praxis. `kind` = fachliche Art (treatment | brace | cosmetic | travel | product), an der
-- Buchbarkeit, Website, Wegegeld usw. hängen; services.category bleibt der Spiegel dieser Art (bestehende Logik unverändert).
CREATE TABLE IF NOT EXISTS "service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'treatment' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "category_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_organization_id_organizations_id_fk') THEN
    ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_category_id_service_categories_id_fk') THEN
    ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_valid_check') THEN
    ALTER TABLE service_categories ADD CONSTRAINT service_categories_valid_check CHECK (
      kind IN ('treatment', 'brace', 'cosmetic', 'travel', 'product')
      AND length(btrim(name)) BETWEEN 1 AND 60
    );
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_categories_org_name" ON "service_categories" USING btree ("organization_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_categories_org" ON "service_categories" USING btree ("organization_id","sort");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_category_id" ON "services" USING btree ("category_id");
--> statement-breakpoint
-- Mandantentrennung (RLS + FORCE) wie bei den übrigen Praxis-Tabellen
ALTER TABLE "service_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "service_categories";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "service_categories"
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Kategorie ↔ Art:
--  * ohne category_id (Ersteinrichtung, Import, Bootstrap, Tests …): erste Kategorie der Art; fehlt sie, wird sie
--    angelegt. Ist der Standardname schon von einer Kategorie anderer Art belegt, „Weitere (<Art>)“ – aber nur, wenn
--    diese (falls schon vorhanden) dieselbe Art hat; sonst Fehler statt falscher Zuordnung.
--  * mit category_id: Art (services.category) kommt aus der Kategorie (eine Quelle der Wahrheit für Buchbarkeit/Wegegeld).
--    Ändert ein UPDATE services.category auf eine Art, die nicht zur Kategorie passt, gibt es einen Fehler (kein stilles
--    Überschreiben).
-- Läuft mit den Rechten der aufrufenden Rolle (RLS gilt).
CREATE OR REPLACE FUNCTION services_default_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cat uuid;
  cat_kind text;
  label text;
BEGIN
  IF NEW.category_id IS NULL THEN
    SELECT c.id INTO cat FROM service_categories c
      WHERE c.organization_id = NEW.organization_id AND c.kind = NEW.category ORDER BY c.sort, c.created_at LIMIT 1;
    IF cat IS NULL THEN
      label := CASE NEW.category WHEN 'brace' THEN 'Nagelkorrektur' WHEN 'cosmetic' THEN 'Kosmetik & Wellness' WHEN 'travel' THEN 'Hausbesuch & Wegegeld' WHEN 'product' THEN 'Verkauf (alt)' ELSE 'Behandlung' END;
      INSERT INTO service_categories (organization_id, name, kind, sort)
      VALUES (NEW.organization_id, label, NEW.category,
        CASE NEW.category WHEN 'brace' THEN 20 WHEN 'cosmetic' THEN 30 WHEN 'travel' THEN 40 WHEN 'product' THEN 50 ELSE 10 END)
      ON CONFLICT (organization_id, name) DO NOTHING
      RETURNING id INTO cat;
      IF cat IS NULL THEN
        -- Standardname schon von einer Kategorie anderer Art belegt: „Weitere (…)“, nur gleiche Art wiederverwenden
        INSERT INTO service_categories (organization_id, name, kind, sort)
        VALUES (NEW.organization_id, 'Weitere (' || label || ')', NEW.category, 90)
        ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name WHERE service_categories.kind = EXCLUDED.kind
        RETURNING id INTO cat;
      END IF;
      IF cat IS NULL THEN
        RAISE EXCEPTION 'Keine passende Kategorie für die Art „%“ – bitte eine Kategorie dieser Art anlegen.', NEW.category
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.category_id := cat;
    RETURN NEW;
  END IF;

  SELECT c.kind INTO cat_kind FROM service_categories c WHERE c.id = NEW.category_id AND c.organization_id = NEW.organization_id;
  IF cat_kind IS NULL THEN
    RAISE EXCEPTION 'Kategorie gehört nicht zu dieser Praxis' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.category IS DISTINCT FROM OLD.category AND NEW.category IS DISTINCT FROM cat_kind THEN
    RAISE EXCEPTION 'Die Art „%“ passt nicht zur Kategorie (Art „%“) – bitte die Kategorie wechseln.', NEW.category, cat_kind
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.category := cat_kind;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS services_default_category ON services;
--> statement-breakpoint
CREATE TRIGGER services_default_category BEFORE INSERT OR UPDATE OF category_id, category ON services
  FOR EACH ROW EXECUTE FUNCTION services_default_category();
--> statement-breakpoint
-- Datenübernahme: Startkategorien (die bisher festen Kategorien; „Verkauf (alt)“ nur, wo es solche Leistungen gibt) und
-- services.category_id. RLS ist auch für den Eigentümer erzwungen → je Praxis app.org_id setzen (wie 0048/0049).
-- Leistungen, die danach noch keine Kategorie haben (Name schon anders belegt), ordnet der Trigger beim UPDATE zu.
DO $$
DECLARE
  o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);

    INSERT INTO service_categories (organization_id, name, kind, sort)
    SELECT o.id, d.name, d.kind, d.sort
      FROM (VALUES ('Behandlung', 'treatment', 10), ('Nagelkorrektur', 'brace', 20), ('Kosmetik & Wellness', 'cosmetic', 30), ('Hausbesuch & Wegegeld', 'travel', 40)) AS d(name, kind, sort)
     WHERE NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.organization_id = o.id AND c.kind = d.kind)
    ON CONFLICT (organization_id, name) DO NOTHING;

    INSERT INTO service_categories (organization_id, name, kind, sort)
    SELECT o.id, 'Verkauf (alt)', 'product', 50
     WHERE EXISTS (SELECT 1 FROM services s WHERE s.organization_id = o.id AND s.category = 'product')
       AND NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.organization_id = o.id AND c.kind = 'product')
    ON CONFLICT (organization_id, name) DO NOTHING;

    -- unbekannte Altwerte (sollte es nicht geben) zählen als Behandlung
    UPDATE services SET category = 'treatment'
     WHERE organization_id = o.id AND category NOT IN ('treatment', 'brace', 'cosmetic', 'travel', 'product');

    UPDATE services s SET category_id = (
      SELECT c.id FROM service_categories c
       WHERE c.organization_id = s.organization_id AND c.kind = s.category ORDER BY c.sort, c.created_at LIMIT 1
    )
     WHERE s.organization_id = o.id AND s.category_id IS NULL;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;
