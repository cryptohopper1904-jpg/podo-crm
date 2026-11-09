/**
 * Cookie für die eingeklappte Navigation. Bewusst NICHT in der Client-Komponente (src/components/sidebar.tsx):
 * Server-Komponenten bekommen aus „use client“-Dateien nur Platzhalter, keine Werte.
 */
export const NAV_COOKIE = "podo_nav";
