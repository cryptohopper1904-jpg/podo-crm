-- Wartelisten-Angebote: Widerruf durch „Rückgängig“ (Absage zurückgenommen) als eigenes Feld, damit status/detail
-- (Versandnachweis, Plattform-Statistik „erinnerungen“) erhalten bleiben. Nur neue Spalte, keine Datenübernahme.
ALTER TABLE "reminder_log" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
