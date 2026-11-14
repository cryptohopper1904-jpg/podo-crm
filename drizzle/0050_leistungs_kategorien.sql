-- Idempotent (IF NOT EXISTS / DROP … IF EXISTS) – darf bei Umnummerierung erneut laufen.
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
-- Startdaten: die bisher festen Kategorien je Praxis („Verkauf (alt)“ nur, wo es solche Leistungen gibt)
INSERT INTO service_categories (organization_id, name, kind, sort)
SELECT o.id, d.name, d.kind, d.sort
FROM organizations o
CROSS JOIN (VALUES ('Behandlung', 'treatment', 10), ('Nagelkorrektur', 'brace', 20), ('Kosmetik & Wellness', 'cosmetic', 30), ('Hausbesuch & Wegegeld', 'travel', 40)) AS d(name, kind, sort)
WHERE NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.organization_id = o.id AND c.kind = d.kind);
--> statement-breakpoint
INSERT INTO service_categories (organization_id, name, kind, sort)
SELECT DISTINCT s.organization_id, 'Verkauf (alt)', 'product', 50
FROM services s
WHERE s.category = 'product'
  AND NOT EXISTS (SELECT 1 FROM service_categories c WHERE c.organization_id = s.organization_id AND c.kind = 'product');
--> statement-breakpoint
-- unbekannte Altwerte (sollte es nicht geben) zählen als Behandlung
UPDATE services SET category = 'treatment' WHERE category NOT IN ('treatment', 'brace', 'cosmetic', 'travel', 'product');
--> statement-breakpoint
UPDATE services s SET category_id = (
  SELECT c.id FROM service_categories c WHERE c.organization_id = s.organization_id AND c.kind = s.category ORDER BY c.sort, c.created_at LIMIT 1
)
WHERE s.category_id IS NULL;
--> statement-breakpoint
-- Leistungen, die ohne Kategorie angelegt werden (Ersteinrichtung, Import, Bootstrap, Tests …), bekommen die erste
-- Kategorie ihrer Art – fehlt sie, wird sie angelegt. Läuft mit den Rechten der aufrufenden Rolle (RLS gilt).
CREATE OR REPLACE FUNCTION services_default_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cat uuid;
BEGIN
  IF NEW.category_id IS NULL THEN
    SELECT c.id INTO cat FROM service_categories c
      WHERE c.organization_id = NEW.organization_id AND c.kind = NEW.category ORDER BY c.sort, c.created_at LIMIT 1;
    IF cat IS NULL THEN
      INSERT INTO service_categories (organization_id, name, kind, sort)
      VALUES (
        NEW.organization_id,
        CASE NEW.category WHEN 'brace' THEN 'Nagelkorrektur' WHEN 'cosmetic' THEN 'Kosmetik & Wellness' WHEN 'travel' THEN 'Hausbesuch & Wegegeld' WHEN 'product' THEN 'Verkauf (alt)' ELSE 'Behandlung' END,
        NEW.category,
        CASE NEW.category WHEN 'brace' THEN 20 WHEN 'cosmetic' THEN 30 WHEN 'travel' THEN 40 WHEN 'product' THEN 50 ELSE 10 END
      )
      ON CONFLICT (organization_id, name) DO NOTHING
      RETURNING id INTO cat;
      IF cat IS NULL THEN
        -- Name schon vergeben (andere Art): eigene Bezeichnung mit Art-Zusatz
        INSERT INTO service_categories (organization_id, name, kind, sort)
        VALUES (NEW.organization_id, 'Weitere (' || NEW.category || ')', NEW.category, 90)
        ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO cat;
      END IF;
    END IF;
    NEW.category_id := cat;
  ELSE
    -- Art immer aus der Kategorie (eine Quelle der Wahrheit für Buchbarkeit/Wegegeld …)
    SELECT c.kind INTO NEW.category FROM service_categories c WHERE c.id = NEW.category_id AND c.organization_id = NEW.organization_id;
    IF NEW.category IS NULL THEN
      RAISE EXCEPTION 'Kategorie gehört nicht zu dieser Praxis' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS services_default_category ON services;
--> statement-breakpoint
CREATE TRIGGER services_default_category BEFORE INSERT OR UPDATE OF category_id, category ON services
  FOR EACH ROW EXECUTE FUNCTION services_default_category();
