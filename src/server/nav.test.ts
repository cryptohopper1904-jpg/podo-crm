/** Navigation je Rolle, Praxis-Modus und Ansicht: jeder erlaubte Bereich ist auf jeder Breite erreichbar (A1). */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("DB darf nicht erreicht werden"); } }),
  withOrg: () => { throw new Error("DB darf nicht erreicht werden"); },
}));
import { can, ROLES, type Role } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { bottomNavSplit, groupNav } from "@/lib/nav";
import { VIEW_LEVELS, splitNav } from "@/lib/view-level";
import { navAllowed } from "./nav";

const as = (role: Role, billingMode: "with_gkv" | "private_only", admin = false) =>
  ({
    sessionId: "s",
    user: { id: "u", email: "t@example.org", name: "T", totpEnabled: true, isPlatformAdmin: admin },
    organization: { id: "o", name: "P", slug: "p", smallBusiness: false, state: "BB", billingMode },
    support: null,
    role,
    can: (p) => can(role, p),
  }) as AuthContext;

describe("navAllowed × Ansicht × Breite", () => {
  for (const role of ROLES)
    for (const mode of ["with_gkv", "private_only"] as const)
      for (const admin of [false, true])
        it(`${role}, ${mode}${admin ? ", Plattform-Admin" : ""}: Handy/Tablet (Leiste + „Mehr“) und Desktop (Gruppen + „Mehr“ + Einstellungen) zeigen alles Erlaubte`, () => {
          const allowed = navAllowed(as(role, mode, admin));
          expect(allowed[0]).toBe("heute");
          for (const level of VIEW_LEVELS) {
            const { visible, more } = splitNav(allowed, level);
            // Handy/Tablet hochkant: untere Leiste + „Mehr“-Blatt (+ Einstellungen fest im Blatt)
            const m = bottomNavSplit(allowed, visible);
            const mobile = new Set([...m.bar, ...m.inView, ...m.hidden, "einstellungen"]);
            for (const k of allowed) expect(mobile.has(k), `${level}: ${k} mobil erreichbar`).toBe(true);
            // Desktop: Gruppen der sichtbaren Punkte + „Mehr“ + Einstellungen unten fest
            const desktop = new Set([...groupNav(visible).flatMap((g) => g.keys), ...more, "einstellungen"]);
            for (const k of allowed) expect(desktop.has(k), `${level}: ${k} am Desktop erreichbar`).toBe(true);
          }
        });

  it("Kasse und Rechnungen sind für die Inhaber:in in „Komplex“ auf dem Handy erreichbar (Befund A1)", () => {
    const allowed = navAllowed(as("owner", "with_gkv"));
    const m = bottomNavSplit(allowed, splitNav(allowed, "komplex").visible);
    expect([...m.bar, ...m.inView]).toEqual(expect.arrayContaining(["rechnungen", "kasse", "produkte", "hygiene", "telefon", "auswertung", "team"]));
  });
});
