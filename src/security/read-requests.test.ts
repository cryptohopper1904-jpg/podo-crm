/**
 * Lese-POSTs (src/lib/auth/read-requests.ts): POST-Route-Handler, die nur lesen, gelten nicht als schreibend –
 * damit funktionieren sie mit Support-Freigabe „read“ und im Nur-Lesen-Modus, und support.view wird wie bei GET
 * entprellt als „read“ protokolliert. Alles andere bleibt schreibend (fail closed).
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { isMutatingRequest, READ_ONLY_POST_PATHS } from "@/lib/auth/read-requests";
import { effectiveCan } from "@/lib/auth/access";
import { createSupportViewLog } from "@/lib/auth/support-view";
import { read, ROOT } from "./app-files";

const SUGGEST = "/api/patienten/vorschlaege";

describe("Lese-POSTs: Klassifizierung", () => {
  it("GET/HEAD lesen, sonst schreibend; fehlende Methode oder fehlender Pfad = schreibend", () => {
    expect(isMutatingRequest("GET", "/kunden")).toBe(false);
    expect(isMutatingRequest("head", "/kunden")).toBe(false);
    expect(isMutatingRequest("POST", "/kunden")).toBe(true);
    expect(isMutatingRequest(null, SUGGEST)).toBe(true);
    expect(isMutatingRequest(undefined, null)).toBe(true);
    // ohne Proxy-Kennung (Pfad fehlt) auch GET schreibend – fail closed
    expect(isMutatingRequest("GET", null)).toBe(true);
    expect(isMutatingRequest("GET", "")).toBe(true);
  });
  it("nur POST auf den exakt gelisteten Pfad gilt als Lesen", () => {
    expect(isMutatingRequest("POST", SUGGEST)).toBe(false);
    for (const m of ["PUT", "PATCH", "DELETE"]) expect(isMutatingRequest(m, SUGGEST)).toBe(true);
    for (const p of [`${SUGGEST}/`, `${SUGGEST}/x`, `${SUGGEST}?q=1`, "/api/patienten", SUGGEST.toUpperCase(), "/api/patienten/vorschlaege%2F"]) {
      expect(isMutatingRequest("POST", p)).toBe(true);
    }
    expect(isMutatingRequest("POST", "constructor")).toBe(true);
    expect(isMutatingRequest("POST", "__proto__")).toBe(true);
  });

  it("jeder Eintrag ist ein Route-Handler, der nur POST exportiert, getAuth nutzt und ein Lese-Recht prüft", () => {
    for (const p of Object.keys(READ_ONLY_POST_PATHS)) {
      const file = path.join(ROOT, "src/app", p, "route.ts");
      expect(existsSync(file), file).toBe(true);
      const src = read(file);
      const methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)].map((m) => m[1]);
      expect(methods, p).toEqual(["POST"]);
      expect(src, p).toMatch(/\bgetAuth\s*\(/);
      expect(src, p).toMatch(/can\("[a-z_]+\.read"\)/);
      // keine Schreibzugriffe im Handler selbst
      expect(src, p).not.toMatch(/\.(insert|update|delete)\(/);
    }
  });
});

describe("Lese-POST im Support-Modus", () => {
  const support = (scope: "read" | "write") => ({ grantId: "g1", scope, expiresAt: new Date(Date.now() + 3600_000) });
  const mutating = isMutatingRequest("POST", SUGGEST);

  it("Freigabe „read“: patients.read erlaubt, Schreibrechte weiterhin verboten", () => {
    const s = { role: "owner" as const, readOnly: false, mutating, support: support("read") };
    expect(effectiveCan(s, "patients.read")).toBe(true);
    expect(effectiveCan(s, "patients.write")).toBe(false);
  });
  it("Nur-Lesen-Modus der Praxis: Suche erlaubt", () => {
    expect(effectiveCan({ role: "therapist", readOnly: true, mutating, support: null }, "patients.read")).toBe(true);
  });
  it("support.view höchstens 1× je Minute (wie GET), echte Schreibanfragen immer", () => {
    const log = createSupportViewLog();
    const t = 1_000_000;
    expect(log.shouldLog("g1", { mutating, path: SUGGEST }, t)).toBe(true);
    expect(log.shouldLog("g1", { mutating, path: SUGGEST }, t + 1_000)).toBe(false);
    expect(log.shouldLog("g1", { mutating, path: SUGGEST }, t + 61_000)).toBe(true);
    const write = isMutatingRequest("POST", "/kunden/neu");
    expect(log.shouldLog("g1", { mutating: write, path: "/kunden/neu" }, t)).toBe(true);
    expect(log.shouldLog("g1", { mutating: write, path: "/kunden/neu" }, t + 1)).toBe(true);
  });
});
