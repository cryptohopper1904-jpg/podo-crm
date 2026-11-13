import { describe, expect, it } from "vitest";
import { can, ROLES, type Role } from "./auth/permissions";
import { firstSettingsHref, SETTINGS_GROUPS, visibleSettingsGroups } from "./settings-tabs";

const hrefs = (role: Role, hidden: string[] = []) =>
  visibleSettingsGroups((t) => !t.perm || can(role, t.perm), hidden).flatMap((g) => g.tabs.map((t) => t.href));

describe("Einstellungs-Navigation nach Rolle", () => {
  it("Inhaber:in sieht alle Bereiche, Ausblendungen der Praxis (z. B. OCR) fallen weg", () => {
    expect(hrefs("owner")).toEqual(SETTINGS_GROUPS.flatMap((g) => g.tabs.map((t) => t.href)));
    expect(hrefs("owner", ["ocr", "ti"])).not.toContain("ocr");
  });
  it("jede Rolle sieht nur, was ihre Rechte erlauben – eigene Sicherheit/Ansicht immer, leere Gruppen fallen weg", () => {
    for (const role of ROLES) {
      const list = hrefs(role);
      expect(list).toContain("sicherheit");
      expect(list).toContain("ansicht");
      for (const g of SETTINGS_GROUPS)
        for (const t of g.tabs) if (t.perm && !can(role, t.perm)) expect(list, `${role}: ${t.href}`).not.toContain(t.href);
    }
    expect(hrefs("trainee")).not.toContain("praxis");
    const none = visibleSettingsGroups((t) => !t.perm);
    expect(none.map((g) => g.label)).toEqual(["Sicherheit & Daten", "Persönlich"]);
    expect(firstSettingsHref(none)).toBe("/einstellungen/sicherheit");
    expect(firstSettingsHref([])).toBe("/einstellungen/ansicht");
  });
});
