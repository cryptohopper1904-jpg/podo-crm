/**
 * Praxis-/Plattform-Wechsel im App-Kopf: welche Ziele eine Person sieht.
 * Reine Logik (ohne DB/Next) – gerendert von src/components/org-switcher.tsx, ausgeführt von
 * switchOrganizationAction (src/app/(auth)/actions.ts).
 */

/** Sonderwert für organizationId: Sitzung ohne Praxis (nur Plattform-Konsole) */
export const PLATFORM_TARGET = "plattform";

export type SwitcherMembership = { organizationId: string; name: string; demo: boolean };

export type SwitcherInput = {
  memberships: SwitcherMembership[];
  /** aktive Praxis der Sitzung (null = Plattform-Sitzung ohne Praxis) */
  currentOrgId: string | null;
  isPlatformAdmin: boolean;
  totpEnabled: boolean;
  /** im Support-Modus (Break-Glass) kein Wechsel über den Kopf – Verlassen über den Support-Hinweis */
  support: boolean;
};

export type SwitcherOption = { value: string; label: string; current: boolean; demo: boolean };

export type SwitcherModel = {
  /** Auswahl anzeigen (mindestens zwei Ziele) */
  show: boolean;
  options: SwitcherOption[];
  /** Link „Zur Plattform-Konsole“ (nur Plattform-Admins mit aktiver 2FA, nicht im Support-Modus) */
  platformLink: boolean;
  /** erste Demo-Praxis mit Mitgliedschaft (für „Demo-Praxis öffnen“) */
  demoOrgId: string | null;
};

export function switcherModel(input: SwitcherInput): SwitcherModel {
  const platformLink = input.isPlatformAdmin && input.totpEnabled && !input.support;
  const options: SwitcherOption[] = [];
  if (platformLink) options.push({ value: PLATFORM_TARGET, label: "Plattform", current: input.currentOrgId === null, demo: false });
  for (const m of input.memberships) {
    options.push({ value: m.organizationId, label: m.name, current: m.organizationId === input.currentOrgId, demo: m.demo });
  }
  const demoOrgId = input.memberships.find((m) => m.demo)?.organizationId ?? null;
  return { show: !input.support && options.length >= 2, options, platformLink, demoOrgId };
}
