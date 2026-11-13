import { readFileSync } from "node:fs";
import path from "node:path";
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

describe("Rechte der Navigation = Rechte der Seiten", () => {
  it("perm/allowReadOnly je Bereich entsprechen dem requireAuth-Aufruf in einstellungen/<href>/page.tsx", () => {
    for (const t of SETTINGS_GROUPS.flatMap((g) => g.tabs)) {
      const src = readFileSync(path.join(__dirname, `../app/(app)/einstellungen/${t.href}/page.tsx`), "utf8");
      const m = src.match(/requireAuth\(([^)]*)\)/);
      expect(m, `${t.href}: requireAuth fehlt`).toBeTruthy();
      const perm = m![1].match(/^"([^"]+)"/)?.[1] ?? null;
      expect(perm, `${t.href}: Recht`).toBe(t.perm);
      expect(/allowReadOnly:\s*true/.test(m![1]), `${t.href}: allowReadOnly`).toBe(!!t.allowReadOnly);
    }
  });
});
