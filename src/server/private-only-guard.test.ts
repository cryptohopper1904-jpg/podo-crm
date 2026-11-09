/**
 * Praxis nur für Privat-/Selbstzahler: Kassen-Aktionen werden serverseitig mit freundlicher Meldung abgewiesen –
 * bevor irgendetwas in der DB passiert (src/lib/features.ts, gkvGuard).
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("DB darf nicht erreicht werden"); } }),
  withOrg: () => { throw new Error("DB darf nicht erreicht werden"); },
}));
import { can } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import * as everordnung from "./everordnung";
import * as ocr from "./ocr";
import * as prescriptions from "./prescriptions";
import * as records from "./records";

const owner = {
  sessionId: "s",
  user: { id: "00000000-0000-0000-0000-000000000001", email: "t@example.org", name: "T", totpEnabled: false, isPlatformAdmin: false },
  organization: { id: "00000000-0000-0000-0000-000000000002", name: "P", slug: "p", smallBusiness: false, state: "BB", billingMode: "private_only" },
  support: null,
  role: "owner",
  can: (p) => can("owner", p),
} as AuthContext;
const id = "00000000-0000-0000-0000-000000000003";
const HINT = /ausgeblendet, weil deine Praxis nur Privatpatient:innen & Selbstzahler behandelt/;

describe("private_only: Verordnungs-Aktionen gesperrt", () => {
  it("Verordnung speichern", async () => {
    const input = prescriptions.prescriptionInput.parse({ patientId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", issuedAt: "2026-11-01", diagnosisGroup: "DF", units: "6" });
    const res = await prescriptions.savePrescription(owner, input);
    expect(res).toEqual({ error: expect.stringMatching(/^Nicht verfügbar: Verordnungen sind ausgeblendet/) });
  });
  it("Status, Zuzahlung, Abrechnungslauf, eVerordnung, OCR, Doku mit Verordnung", async () => {
    expect(await prescriptions.changePrescriptionStatus(owner, { id, patientId: id, to: "cancelled" })).toEqual({ error: expect.stringMatching(HINT) });
    expect(await prescriptions.setCopaymentPaid(owner, { id, patientId: id, paid: true })).toEqual({ error: expect.stringMatching(HINT) });
    expect(await prescriptions.createBillingBatch(owner, [id], { partner: "manual" })).toEqual({ error: expect.stringMatching(HINT) });
    expect(await everordnung.previewEverordnung(owner, "<Bundle/>")).toEqual({ error: expect.stringMatching(HINT) });
    expect(await everordnung.importEverordnung(owner, "<Bundle/>", {})).toEqual({ error: expect.stringMatching(HINT) });
    expect(await ocr.extractPrescriptionFromMedia(owner, { patientId: id, mediaId: id })).toEqual({ error: expect.stringMatching(HINT) });
    expect(await records.createTreatmentRecord(owner, { patientId: id, findings: "o. B.", servicesText: null, prescriptionId: id })).toEqual({ error: expect.stringMatching(HINT) });
  });
});
