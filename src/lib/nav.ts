/**
 * Cookie für die eingeklappte Navigation. Bewusst NICHT in der Client-Komponente (src/components/sidebar.tsx):
 * Server-Komponenten bekommen aus „use client“-Dateien nur Platzhalter, keine Werte.
 */
export const NAV_COOKIE = "podo_nav";

/** Schlüssel der Hauptnavigation (Liste mit Beschriftung und Icon: src/components/app-nav.tsx) */
export type NavKey =
  | "heute"
  | "kalender"
  | "touren"
  | "kunden"
  | "doku"
  | "posteingang"
  | "rechnungen"
  | "gutscheine"
  | "bewertungen"
  | "news"
  | "auswertung"
  | "einstellungen"
  | "verordnungen"
  | "pflegeheime"
  | "hygiene"
  | "team"
  | "kasse"
  | "telefon"
  | "plattform";
