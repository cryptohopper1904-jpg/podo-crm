import { describe, expect, it } from "vitest";
import { confirmsPracticeName, deletionDueAt, isWithinGrace, purgeCutoff } from "./org-deletion";
import { mediaPath, stripRow, tenantTables } from "./practice-export";

describe("Praxis-Export", () => {
  it("erfasst alle Mandanten-Tabellen und lässt Technik-Tabellen weg", () => {
    const names = tenantTables().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["patients", "treatment_records", "media", "invoices", "memberships", "audit_log", "integration_connections"]));
    expect(names).not.toContain("sessions");
    expect(names).not.toContain("organizations");
    expect(names).not.toContain("users");
  });

  it("jede Mandanten-Tabelle hat eine Spalte id (seitenweiser Export per Keyset)", () => {
    const missing = tenantTables().filter((t) => !("id" in (t.table as unknown as Record<string, unknown>))).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("entfernt Geheimnisse und interne Pfade", () => {
    const tables = Object.fromEntries(tenantTables().map((t) => [t.name, t.strippedKeys]));
    expect(tables.integration_connections).toContain("secretEnc");
    expect(tables.patient_links).toContain("tokenHash");
    expect(tables.media).toContain("storageKey");
    expect(stripRow({ a: 1, secretEnc: "x" }, ["secretEnc"])).toEqual({ a: 1 });
  });

  it("baut sichere Dateipfade für Medien", () => {
    expect(mediaPath({ id: "abcdef12-3456", mime: "image/jpeg", purpose: "before", takenAt: new Date("2026-03-04T10:00:00Z") }, 17)).toBe(
      "media/17/2026-03-04_before_abcdef12.jpg",
    );
    expect(mediaPath({ id: "../../etc", mime: "x/y", purpose: "a/b", takenAt: "2026-01-01T00:00:00Z" }, null)).toBe("media/ohne-zuordnung/2026-01-01_a_b_______et.bin");
  });
});

describe("Kündigung & Löschung", () => {
  it("rechnet die Karenzzeit von 30 Tagen", () => {
    const req = new Date("2026-01-01T00:00:00Z");
    expect(deletionDueAt(req).toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(isWithinGrace(req, new Date("2026-01-30T23:59:00Z"))).toBe(true);
    expect(isWithinGrace(req, new Date("2026-01-31T00:00:01Z"))).toBe(false);
    expect(purgeCutoff(new Date("2026-01-31T00:00:00Z")).toISOString()).toBe(req.toISOString());
  });

  it("verlangt den Praxisnamen", () => {
    expect(confirmsPracticeName("  podologie  am   markt ", "Podologie am Markt")).toBe(true);
    expect(confirmsPracticeName("Podologie", "Podologie am Markt")).toBe(false);
    expect(confirmsPracticeName("", "")).toBe(false);
  });
});
