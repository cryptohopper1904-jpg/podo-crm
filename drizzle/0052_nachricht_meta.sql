-- Strukturierte Zusatzangaben je Nachricht (z. B. Vor-/Nachname einer Online-Anfrage, damit sie vor einem
-- KI-Antwortvorschlag zuverlässig entfernt werden). Idempotent; keine Datenübernahme, RLS unverändert (Spalte).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "meta" jsonb;
