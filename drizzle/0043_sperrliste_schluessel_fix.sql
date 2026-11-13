-- Idempotent. Kanarienwert des Sperrlisten-Schlüssels (0042): nach dem ersten Setzen unveränderbar – weder ändern noch
-- auf NULL setzen (sonst ließe sich die Fail-closed-Prüfung nach einem Schlüsseltausch still „reparieren“ und die
-- Sperrliste wäre unbemerkt wirkungslos). Abhilfe bei Abweichung: alten APP_ENCRYPTION_KEY einsetzen (docs/BETRIEB.md).
CREATE OR REPLACE FUNCTION podo_sales_settings_key_check_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.blocklist_key_check IS NOT NULL AND NEW.blocklist_key_check IS DISTINCT FROM OLD.blocklist_key_check THEN
    RAISE EXCEPTION 'Sperrlisten-Kanarienwert ist unveränderbar (siehe docs/BETRIEB.md)';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS sales_settings_key_check_guard ON sales_settings;
--> statement-breakpoint
CREATE TRIGGER sales_settings_key_check_guard BEFORE UPDATE ON sales_settings FOR EACH ROW EXECUTE FUNCTION podo_sales_settings_key_check_guard();
