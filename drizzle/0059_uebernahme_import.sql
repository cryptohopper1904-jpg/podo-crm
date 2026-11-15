-- Übernahme-Assistent (Einstellungen → Import → Daten übernehmen): eigene Termin-Quelle für Termine aus anderer
-- Praxissoftware (external_id = „<quelle>:<id>“, z. B. „tinana:…“). Idempotent (IF NOT EXISTS) – darf bei
-- Umnummerierung erneut laufen. Der neue Wert wird in keiner späteren Anweisung derselben Transaktion verwendet
-- (PostgreSQL erlaubt das erst nach dem Commit).
ALTER TYPE "public"."appointment_source" ADD VALUE IF NOT EXISTS 'import';
