/**
 * Beträge in Patientenliste und Akte nur mit Rechnungs-Leserecht (echte DB, RLS aktiv, erfundene Daten):
 * Rollen ohne invoices.read (z. B. Azubi) bekommen offene Beträge/Umsatz und Rechnungen gar nicht erst geliefert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import { can, type Role } from "@/lib/auth/permissions";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Beträge nur mit Rechnungs-Leserecht (DB)", () => {
  const f = fixtures(TEST_DB!);
  let pts: typeof import("./patients");
  let org: string;
  let user: string;
  let patient: string;

  const auth = (role: Role) =>
    ({ role, support: null, organization: { id: org }, user: { id: user }, can: (p: Parameters<typeof can>[1]) => can(role, p) }) as unknown as AuthContext;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    pts = await import("./patients");
    org = await f.org();
    user = await f.user();
    patient = await f.patient(org, { lastName: "Beispielbetrag", firstName: "Offen" });
    await f.invoice(org, patient, 4200);
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Inhaber:in sieht den offenen Betrag in Liste und Akte", async () => {
    const [row] = (await pts.listPatients(auth("owner"))).filter((r) => r.id === patient);
    expect(row.openCents).toBe(4200);
    const akte = await pts.getPatient(auth("owner"), patient);
    expect(akte?.openCents).toBe(4200);
    expect(akte?.revenueCents).toBe(0);
    expect(akte?.invoices).toHaveLength(1);
  });

  it("Azubi (ohne invoices.read) bekommt keine Beträge und keine Rechnungen", async () => {
    expect(can("trainee", "invoices.read")).toBe(false);
    const [row] = (await pts.listPatients(auth("trainee"))).filter((r) => r.id === patient);
    expect(row).toBeDefined();
    expect(row.openCents).toBeNull();
    const akte = await pts.getPatient(auth("trainee"), patient);
    expect(akte?.openCents).toBeNull();
    expect(akte?.revenueCents).toBeNull();
    expect(akte?.invoices).toEqual([]);
  });
});
