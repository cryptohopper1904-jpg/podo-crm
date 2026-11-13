-- Produkte & Warenwirtschaft: Mandantentrennung (RLS + FORCE), unveränderbare Lagerbewegungen und
-- zweite Sicherung neben der App-Prüfung (gültige Werte, Bezüge nur innerhalb derselben Praxis).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','products','stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_category_check CHECK (category IN ('salbe', 'creme', 'pflege', 'hilfsmittel', 'sonstiges'));
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_vat_rate_check CHECK (vat_rate IN (7, 19));
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_price_check CHECK (price_cents >= 0 AND (purchase_price_cents IS NULL OR purchase_price_cents >= 0) AND min_stock >= 0);
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_name_check CHECK (length(btrim(name)) > 0);
--> statement-breakpoint
ALTER TABLE suppliers ADD CONSTRAINT suppliers_name_check CHECK (length(btrim(name)) > 0);
--> statement-breakpoint
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('receipt', 'sale', 'storno', 'inventory', 'breakage', 'own_use'));
--> statement-breakpoint
-- Vorzeichen passend zur Art: Zugang positiv, Verkauf/Bruch/Eigenverbrauch negativ, Inventur beides (nie 0)
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_quantity_check CHECK (
  quantity <> 0
  AND (kind NOT IN ('receipt', 'storno') OR quantity > 0)
  AND (kind NOT IN ('sale', 'breakage', 'own_use') OR quantity < 0)
  AND (kind NOT IN ('sale', 'storno') OR invoice_id IS NOT NULL)
  AND (unit_cost_cents IS NULL OR unit_cost_cents >= 0)
);
--> statement-breakpoint
-- Rechnungsposition: Produktposition ↔ product_id; „in der Behandlung angewendet“ nur bei Produkt mit 0 %
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check CHECK (
  line_kind IN ('service', 'product')
  AND ((line_kind = 'product') = (product_id IS NOT NULL))
  AND (NOT in_treatment OR (line_kind = 'product' AND vat_rate = 0))
);
--> statement-breakpoint
-- Lagerbewegungen sind unveränderbar (Bestand = Summe der Bewegungen); Korrektur nur als neue Bewegung
CREATE OR REPLACE FUNCTION podo_forbid_stock_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Lagerbewegungen sind unveränderbar (%). Bitte eine Korrekturbuchung anlegen.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION podo_forbid_stock_change();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION podo_forbid_truncate();
--> statement-breakpoint
-- Fremdschlüssel-Prüfungen umgehen RLS: Bezüge nur zu Datensätzen derselben Praxis
CREATE OR REPLACE FUNCTION podo_product_refs_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    IF NEW.supplier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'Lieferant gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'stock_movements' THEN
    IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'Produkt gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.supplier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = NEW.supplier_id AND s.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'Lieferant gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.invoice_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'Beleg gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'invoice_lines' THEN
    IF NEW.product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'Produkt gehört nicht zu dieser Praxis.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER products_refs_org BEFORE INSERT OR UPDATE OF supplier_id, organization_id ON products
  FOR EACH ROW EXECUTE FUNCTION podo_product_refs_org();
--> statement-breakpoint
CREATE TRIGGER stock_movements_refs_org BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION podo_product_refs_org();
--> statement-breakpoint
CREATE TRIGGER invoice_lines_product_org BEFORE INSERT OR UPDATE OF product_id, organization_id ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION podo_product_refs_org();
