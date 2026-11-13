-- Öffnungszeiten je Wochentag (settings.practiceHours, siehe src/lib/opening-hours.ts). Idempotent.
-- 1) Alter Mo–Fr-Bereich settings.opening (ohne Angabe 08:00–18:00) → Mo–Fr gleiche Zeiten, Sa/So geschlossen.
UPDATE "organizations"
SET "settings" = "settings" || jsonb_build_object('practiceHours', (
  SELECT jsonb_agg(jsonb_build_object(
    'weekday', d,
    'from', CASE WHEN jsonb_typeof("settings"->'opening') = 'object' AND jsonb_typeof("settings"->'opening'->'from') = 'string' THEN "settings"->'opening'->>'from' ELSE '08:00' END,
    'to', CASE WHEN jsonb_typeof("settings"->'opening') = 'object' AND jsonb_typeof("settings"->'opening'->'to') = 'string' THEN "settings"->'opening'->>'to' ELSE '18:00' END
  ) ORDER BY d)
  FROM generate_series(1, 5) AS d
))
WHERE NOT ("settings" ? 'practiceHours');--> statement-breakpoint
-- 2) Website: bisher eigens gepflegte Website-Zeiten (settings.openingHours) bleiben als abweichende Zeiten erhalten
--    (website.customHours = true); ohne eigene Zeiten zeigt die Website künftig die Praxis-Öffnungszeiten.
UPDATE "organizations"
SET "settings" = jsonb_set(
  "settings",
  '{website}',
  (CASE WHEN jsonb_typeof("settings"->'website') = 'object' THEN "settings"->'website' ELSE '{}'::jsonb END)
    || jsonb_build_object('customHours', jsonb_typeof("settings"->'openingHours') = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof("settings"->'openingHours') = 'array' THEN "settings"->'openingHours' ELSE '[]'::jsonb END) > 0)
)
WHERE NOT coalesce(jsonb_typeof("settings"->'website') = 'object' AND "settings"->'website' ? 'customHours', false);
