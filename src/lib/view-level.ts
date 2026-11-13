import type { NavKey } from "./nav";

/**
 * Ansicht „Einfach“ / „Kompakt“ / „Komplex“ – persönliche Einstellung je Person (users.prefs.view).
 * Sie blendet nur aus, was in der linken Navigation und auf der Startseite „Heute“ angezeigt wird:
 * Rechte und Tarif-/Praxis-Schalter bleiben unberührt, ausgeblendete Bereiche sind weiter per Link
 * („Mehr“ unten in der Navigation, /bereiche) und per URL erreichbar.
 * Standard ist „Komplex“ = alles wie bisher.
 */
export const VIEW_LEVELS = ["einfach", "kompakt", "komplex"] as const;
export type ViewLevel = (typeof VIEW_LEVELS)[number];
export const DEFAULT_VIEW_LEVEL: ViewLevel = "komplex";

export const VIEW_LEVEL_LABELS: Record<ViewLevel, string> = {
  einfach: "Einfach",
  kompakt: "Kompakt",
  komplex: "Komplex",
};

export const VIEW_LEVEL_HINTS: Record<ViewLevel, string> = {
  einfach: "Nur das Wichtigste für den Praxisalltag: Termine, Patient:innen, Behandlung, Rechnungen und Kasse. Startseite mit den heutigen Terminen, Schnellzugriff und offenen Aufgaben.",
  kompakt: "Dazu Posteingang, Verordnungen, Touren, Gutscheine und Auswertung (Finanzen, Termine, Leistungen & Produkte). Startseite ohne Nebenkarten.",
  komplex: "Alle Bereiche und die vollständige Startseite (wie bisher).",
};

const EINFACH: readonly NavKey[] = ["heute", "kalender", "kunden", "doku", "rechnungen", "kasse", "einstellungen"];
const KOMPAKT: readonly NavKey[] = [...EINFACH, "posteingang", "verordnungen", "touren", "gutscheine", "auswertung"];

/** Navigationspunkte je Ansicht; null = keine Einschränkung (alle erlaubten Punkte) */
export const NAV_BY_LEVEL: Record<ViewLevel, readonly NavKey[] | null> = {
  einfach: EINFACH,
  kompakt: KOMPAKT,
  komplex: null,
};

export function isViewLevel(v: unknown): v is ViewLevel {
  return typeof v === "string" && (VIEW_LEVELS as readonly string[]).includes(v);
}

/** Wert aus users.prefs (oder Formular) lesen; Unbekanntes/Fehlendes → Standard „Komplex“ */
export function viewLevelOf(prefs: { view?: unknown } | null | undefined): ViewLevel {
  const v = prefs?.view;
  return isViewLevel(v) ? v : DEFAULT_VIEW_LEVEL;
}

/**
 * Teilt die (bereits nach Rechten/Tarif gefilterten) Navigationspunkte in sichtbare und „Mehr“.
 * Reihenfolge bleibt erhalten; es kommen nie Punkte hinzu, die nicht in `allowed` stehen.
 */
export function splitNav<K extends NavKey>(allowed: readonly K[], level: ViewLevel): { visible: K[]; more: K[] } {
  const keep = NAV_BY_LEVEL[level];
  if (!keep) return { visible: [...allowed], more: [] };
  const visible: K[] = [];
  const more: K[] = [];
  for (const k of allowed) (keep.includes(k) ? visible : more).push(k);
  return { visible, more };
}

/** Bereiche der Startseite „Heute“ je Ansicht */
export type TodaySections = {
  /** Kennzahlen-Kacheln (Termine, Einnahmen, Offene Posten, Nachrichten) */
  stats: boolean;
  /** Schnellzugriff-Leiste (nur „Einfach“: ersetzt die Kennzahlen) */
  quickActions: boolean;
  /** Karte „Posteingang“ (neueste Nachrichten) */
  inbox: boolean;
  /** Erinnerung an offene Sammelrechnungen zum Jahresende (wichtige Aufgabe – in allen Ansichten) */
  collective: boolean;
  /** Karte „Aufgaben“: immer oder nur, wenn etwas offen ist („Einfach“) */
  tasks: "always" | "ifOpen";
  /** Karte „Schnittstellen“ (Status der Verbindungen) */
  integrations: boolean;
};

export function todaySections(level: ViewLevel): TodaySections {
  switch (level) {
    case "einfach":
      return { stats: false, quickActions: true, inbox: false, collective: true, tasks: "ifOpen", integrations: false };
    case "kompakt":
      return { stats: true, quickActions: false, inbox: true, collective: true, tasks: "always", integrations: false };
    default:
      return { stats: true, quickActions: false, inbox: true, collective: true, tasks: "always", integrations: true };
  }
}

/**
 * Auswertung (Reiter Termine / Leistungen & Produkte): Kennzahlen und Diagramme sehen alle gleich.
 * Detailtabellen (Werte je Slot, Quellen, Lagerliste) sind nur in „Komplex“ aufgeklappt, sonst eingeklappt erreichbar.
 * Die Auswertung selbst steht ab „Kompakt“ in der Navigation (in „Einfach“ unter „Mehr“).
 */
export function statsDetailsOpen(level: ViewLevel): boolean {
  return level === "komplex";
}
