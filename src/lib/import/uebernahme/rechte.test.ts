/** Rechte des Übernahme-Assistenten: nur Inhaber:in; Support (auch mit Schreib-Freigabe) und Nur-Lesen-Modus gesperrt. */
import { describe, expect, it } from "vitest";
import { effectiveCan } from "@/lib/auth/access";
import { ROLES } from "@/lib/auth/permissions";

const support = { grantId: "g", scope: "write" as const, expiresAt: new Date(Date.now() + 3600_000) };

describe("Übernahme-Assistent: Rechte (import.run + settings.manage)", () => {
  it("nur die Inhaber:in darf importieren", () => {
    const allowed = ROLES.filter((role) => effectiveCan({ role, readOnly: false, mutating: true, support: null }, "import.run") && effectiveCan({ role, readOnly: false, mutating: true, support: null }, "settings.manage"));
    expect(allowed).toEqual(["owner"]);
  });
  it("Support-Zugriff mit Schreib-Freigabe darf nicht importieren", () => {
    expect(effectiveCan({ role: "owner", readOnly: false, mutating: true, support }, "import.run")).toBe(false);
  });
  it("Nur-Lesen-Modus blockiert den Import (schreibende Anfrage)", () => {
    expect(effectiveCan({ role: "owner", readOnly: true, mutating: true, support: null }, "import.run")).toBe(false);
  });
});
