/**
 * Server Actions sind öffentlich aufrufbare POST-Endpunkte. Jede exportierte Funktion einer
 * "use server"-Datei muss die Sitzung prüfen (requireAuth/getAuth/getSession oder ein Wrapper, der
 * nachweislich requireAuth aufruft) – oder bewusst öffentlich sein (Allowlist mit Begründung).
 */
import { describe, expect, it } from "vitest";
import { functionsOf, isServerActionFile, read, rel, SRC, walk } from "./app-files";

const BASE_GUARDS = ["requireAuth", "getAuth", "getSession"];

/** "datei" (alle Funktionen) oder "datei#funktion" → Begründung */
export const PUBLIC_ACTIONS: Record<string, string> = {
  "src/app/(auth)/actions.ts#loginAction": "Anmeldung (Rate-Limit, Argon2)",
  "src/app/(auth)/actions.ts#verifyTotpAction": "2FA-Schritt (unverifizierte Sitzung)",
  "src/app/(auth)/actions.ts#logoutAction": "Abmelden",
  "src/app/(auth)/actions.ts#setupAction": "Ersteinrichtung (SETUP_TOKEN / ALLOW_SIGNUP)",
  "src/app/(auth)/password-actions.ts#requestPasswordResetAction": "Passwort vergessen (neutrale Antwort, Rate-Limit je IP und E-Mail, Mindestlaufzeit)",
  "src/app/(auth)/password-actions.ts#resetPasswordAction": "Neues Passwort per Einmal-Token (sha256, 30 min, einmalig)",
  "src/app/buchen/[slug]/actions.ts#bookAction": "Online-Buchung (Rate-Limit, Honeypot, nie Aktenzuordnung)",
  "src/app/anamnese/[token]/actions.ts": "Anamnese per Einmal-Token",
  "src/server/portal.ts#cancelPortalAppointmentAction": "Kundenportal (signierte Portal-Sitzung)",
  "src/server/portal.ts#bookPortalAppointmentAction": "Kundenportal-Buchung (signierte Portal-Sitzung, Rate-Limit je IP und Person)",
  "src/app/portal/angebot/[token]/actions.ts#acceptOfferAction": "Wartelisten-Angebot (Einmal-Token, Rate-Limit, Buchungssperre)",
};

const files = walk(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: rel(f), src: read(f) }));

/** Wrapper-Funktionen (irgendwo in src), deren Rumpf eine Basis-Prüfung aufruft, z. B. requireHygiene, ownerAuth. */
function guardNames(): Set<string> {
  const guards = new Set(BASE_GUARDS);
  const re = new RegExp(`\\b(${BASE_GUARDS.join("|")})\\s*\\(`);
  for (const { src } of files) for (const fn of functionsOf(src)) if (re.test(fn.body)) guards.add(fn.name);
  return guards;
}

describe("Server Actions: Authentisierung", () => {
  const actionFiles = files.filter((f) => isServerActionFile(f.src));
  const guards = guardNames();
  const guardRe = new RegExp(`\\b(${[...guards].join("|")})\\s*\\(`);

  it("findet die Action-Dateien", () => {
    expect(actionFiles.length).toBeGreaterThan(15);
    expect(actionFiles.map((f) => f.file)).toContain("src/app/(app)/telefon/actions.ts");
  });

  it("jede exportierte Action prüft die Sitzung oder ist bewusst öffentlich", () => {
    const unprotected: string[] = [];
    for (const { file, src } of actionFiles) {
      if (file in PUBLIC_ACTIONS) continue;
      for (const fn of functionsOf(src).filter((f) => f.exported)) {
        const key = `${file}#${fn.name}`;
        if (key in PUBLIC_ACTIONS) continue;
        // Prüfung muss im Rumpf der Action selbst stehen (nicht nur irgendwo in der Datei)
        const own = fn.body.replace(fn.name, "");
        if (!guardRe.test(own)) unprotected.push(key);
      }
    }
    expect(unprotected).toEqual([]);
  });

  it("in 'use server'-Dateien wird nur Asynchrones exportiert (keine Hilfsfunktionen als offene Endpunkte)", () => {
    const bad: string[] = [];
    for (const { file, src } of actionFiles) {
      for (const m of src.matchAll(/^export\s+(?!async\s+function|type\s|interface\s)(\w+)\s+(\w+)/gm)) bad.push(`${file}: export ${m[1]} ${m[2]}`);
    }
    expect(bad).toEqual([]);
  });

  it("Allowlist enthält keine Leichen", () => {
    const stale = Object.keys(PUBLIC_ACTIONS).filter((k) => {
      const [file, fn] = k.split("#");
      const f = actionFiles.find((x) => x.file === file);
      return !f || (fn && !functionsOf(f.src).some((x) => x.exported && x.name === fn));
    });
    expect(stale).toEqual([]);
  });
});
