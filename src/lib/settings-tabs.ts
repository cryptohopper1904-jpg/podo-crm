/**
 * Bereiche der Einstellungen in Gruppen – mit dem Recht, das die jeweilige Seite verlangt (requireAuth in
 * src/app/(app)/einstellungen/<href>/page.tsx). Die Navigation zeigt nur, was die Rolle auch öffnen darf.
 * Keine Server-Importe (auch im Browser nutzbar).
 */
import type { Permission } from "./auth/permissions";

export type SettingsTab = {
  href: string;
  label: string;
  /** null = jede angemeldete Person (eigene Ansicht, eigenes Passwort/2FA) */
  perm: Permission | null;
  /** Seite ist auch im Lesemodus (Abo abgelaufen) erreichbar, um ihn zu beheben – requireAuth(…, { allowReadOnly }) */
  allowReadOnly?: boolean;
};
export type SettingsGroup = { label: string; tabs: SettingsTab[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Praxis",
    tabs: [
      { href: "praxis", label: "Praxisdaten", perm: "settings.manage" },
      { href: "oeffnungszeiten", label: "Öffnungszeiten", perm: "settings.manage" },
      { href: "team", label: "Team & Rollen", perm: "users.manage" },
      { href: "leistungen", label: "Leistungen", perm: "settings.manage" },
      { href: "erinnerungen", label: "Erinnerungen", perm: "settings.manage" },
      { href: "fahrten", label: "Fahrten & Startorte", perm: "settings.manage" },
      { href: "website", label: "Website", perm: "settings.manage" },
    ],
  },
  {
    label: "Verbindungen",
    tabs: [
      { href: "schnittstellen", label: "Schnittstellen", perm: "integrations.manage" },
      { href: "kalender-abo", label: "Kalender-Abo", perm: "integrations.manage" },
      { href: "ti", label: "TI & KIM", perm: "settings.manage" },
      { href: "ocr", label: "Verordnungs-OCR", perm: "settings.manage" },
      { href: "import", label: "Import", perm: "import.run" },
    ],
  },
  {
    label: "Sicherheit & Daten",
    tabs: [
      { href: "sicherheit", label: "Sicherheit", perm: null },
      { href: "protokoll", label: "Zugriffsprotokoll", perm: "audit.read" },
      { href: "support", label: "Support-Zugriff", perm: "users.manage", allowReadOnly: true },
      { href: "daten", label: "Daten & Kündigung", perm: "settings.manage" },
    ],
  },
  { label: "Vertrag", tabs: [{ href: "abo", label: "Abo & Tarif", perm: "settings.manage", allowReadOnly: true }] },
  { label: "Persönlich", tabs: [{ href: "ansicht", label: "Ansicht", perm: null }] },
];

/**
 * Sichtbare Gruppen: Tabs ohne Recht bzw. per Funktion ausgeblendete (`hidden`, z. B. „ti“/„ocr“ bei reinen
 * Privatpraxen) fallen weg, leere Gruppen ebenso. `allowed` entscheidet wie requireAuth.
 */
export function visibleSettingsGroups(allowed: (tab: SettingsTab) => boolean, hidden: readonly string[] = []): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({ label: g.label, tabs: g.tabs.filter((t) => !hidden.includes(t.href) && allowed(t)) })).filter((g) => g.tabs.length);
}

/** Erster erreichbarer Bereich (Ziel von /einstellungen) */
export const firstSettingsHref = (groups: SettingsGroup[]) => `/einstellungen/${groups[0]?.tabs[0]?.href ?? "ansicht"}`;
