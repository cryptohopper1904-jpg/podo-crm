-- Praxis-Logos: Mandantentrennung (RLS + FORCE) und nur bekannte Arten/Dateitypen
ALTER TABLE organization_logos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organization_logos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organization_logos
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE organization_logos ADD CONSTRAINT organization_logos_kind_check CHECK (kind IN ('compact', 'full'));
--> statement-breakpoint
ALTER TABLE organization_logos ADD CONSTRAINT organization_logos_mime_check CHECK (mime IN ('image/png', 'image/jpeg'));
--> statement-breakpoint
ALTER TABLE organization_logos ADD CONSTRAINT organization_logos_size_check CHECK (size_bytes > 0 AND size_bytes <= 1048576 AND width > 0 AND height > 0);
