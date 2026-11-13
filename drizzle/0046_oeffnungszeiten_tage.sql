-- Öffnungszeiten je Wochentag (settings.practiceHours, siehe src/lib/opening-hours.ts storedPracticeHours). Idempotent.
-- Nur Praxen MIT Altdaten bekommen practiceHours – ohne Angaben keine erfundenen Zeiten (intern weiter Mo–Fr 08–18).
-- Zeiten außerhalb des 5-Minuten-Rasters: „von“ nach unten, „bis“ nach oben (höchstens 23:55).
--
-- 1) Bisherige Website-Zeiten (settings.openingHours, z. B. aus dem Bootstrap) → Praxis-Öffnungszeiten.
--    Gültig wie in websiteSettings()/openingHours(): Wochentag 1–7, HH:MM, von < bis.
WITH entries AS (
  SELECT o."id", (e->>'weekday')::int AS wd,
    floor(((split_part(e->>'from', ':', 1))::int * 60 + (split_part(e->>'from', ':', 2))::int) / 5.0)::int * 5 AS f,
    least(ceil(((split_part(e->>'to', ':', 1))::int * 60 + (split_part(e->>'to', ':', 2))::int) / 5.0)::int * 5, 1435) AS t
  FROM "organizations" o, jsonb_array_elements(o."settings"->'openingHours') AS e
  WHERE NOT (o."settings" ? 'practiceHours')
    AND jsonb_typeof(o."settings"->'openingHours') = 'array'
    AND jsonb_typeof(e) = 'object'
    AND jsonb_typeof(e->'weekday') = 'number' AND (e->>'weekday') ~ '^[1-7]$'
    AND jsonb_typeof(e->'from') = 'string' AND (e->>'from') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND jsonb_typeof(e->'to') = 'string' AND (e->>'to') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND (e->>'from') < (e->>'to')
),
hours AS (
  SELECT "id", jsonb_agg(jsonb_build_object(
      'weekday', wd,
      'from', lpad((f / 60)::text, 2, '0') || ':' || lpad((f % 60)::text, 2, '0'),
      'to', lpad((t / 60)::text, 2, '0') || ':' || lpad((t % 60)::text, 2, '0')
    ) ORDER BY wd, f) AS list
  FROM entries WHERE f < t GROUP BY "id"
)
UPDATE "organizations" o
SET "settings" = o."settings" || jsonb_build_object('practiceHours', hours.list)
FROM hours
WHERE o."id" = hours."id";--> statement-breakpoint
-- 2) Sonst alter Mo–Fr-Bereich settings.opening (fehlende Teile wie bisher 08:00 bzw. 18:00) → Mo–Fr gleiche Zeiten;
--    unlesbarer Bereich galt schon bisher als „keine Öffnungszeit“ → leere Liste.
WITH rng AS (
  SELECT "id",
    CASE WHEN jsonb_typeof("settings"->'opening'->'from') = 'string' THEN "settings"->'opening'->>'from' ELSE '08:00' END AS fs,
    CASE WHEN jsonb_typeof("settings"->'opening'->'to') = 'string' THEN "settings"->'opening'->>'to' ELSE '18:00' END AS ts
  FROM "organizations"
  WHERE NOT ("settings" ? 'practiceHours') AND jsonb_typeof("settings"->'opening') = 'object'
),
mins AS (
  SELECT "id",
    CASE WHEN fs ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ts ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND fs < ts
      THEN floor((split_part(fs, ':', 1)::int * 60 + split_part(fs, ':', 2)::int) / 5.0)::int * 5 END AS f,
    CASE WHEN fs ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ts ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND fs < ts
      THEN least(ceil((split_part(ts, ':', 1)::int * 60 + split_part(ts, ':', 2)::int) / 5.0)::int * 5, 1435) END AS t
  FROM rng
)
UPDATE "organizations" o
SET "settings" = o."settings" || jsonb_build_object('practiceHours', CASE WHEN mins.f IS NULL OR mins.f >= mins.t THEN '[]'::jsonb ELSE (
  SELECT jsonb_agg(jsonb_build_object(
    'weekday', d,
    'from', lpad((mins.f / 60)::text, 2, '0') || ':' || lpad((mins.f % 60)::text, 2, '0'),
    'to', lpad((mins.t / 60)::text, 2, '0') || ':' || lpad((mins.t % 60)::text, 2, '0')
  ) ORDER BY d) FROM generate_series(1, 5) AS d) END)
FROM mins
WHERE o."id" = mins."id";--> statement-breakpoint
-- 3) Website-Schalter: bisherige Website-Zeiten sind jetzt die Praxis-Öffnungszeiten → customHours = false.
UPDATE "organizations"
SET "settings" = jsonb_set(
  "settings",
  '{website}',
  (CASE WHEN jsonb_typeof("settings"->'website') = 'object' THEN "settings"->'website' ELSE '{}'::jsonb END) || '{"customHours": false}'::jsonb
)
WHERE NOT coalesce(jsonb_typeof("settings"->'website') = 'object' AND "settings"->'website' ? 'customHours', false);
