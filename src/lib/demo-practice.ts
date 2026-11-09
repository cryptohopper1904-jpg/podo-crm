/**
 * Kennzeichnung der Demo-Praxis des Plattform-Admins (Bootstrap, src/lib/bootstrap.ts): erfundene Beispieldaten,
 * Tarif „internal“, organizations.settings.demo = true. Ohne DB-/Next-Abhängigkeiten (läuft auch im migrate-Container).
 */
export const DEMO_PRACTICE_SLUG = "demo-praxis";
export const DEMO_PRACTICE_NAME = "Demo-Praxis (Beispieldaten)";

/** true, wenn die Praxis als Demo-Praxis markiert ist (organizations.settings.demo) */
export const isDemoPractice = (settings: Record<string, unknown> | null | undefined) => settings?.demo === true;
