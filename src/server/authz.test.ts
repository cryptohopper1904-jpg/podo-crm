/** Defense in Depth: Fachfunktionen prüfen die Rolle selbst (ohne DB – die Prüfung greift vor jeder Abfrage). */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("DB darf nicht erreicht werden"); } }),
  withOrg: () => { throw new Error("DB darf nicht erreicht werden"); },
}));
import { can, type Role } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { ForbiddenError } from "./authz";
import * as anamnesis from "./anamnesis";
import * as careHomes from "./care-homes";
import * as prescriptions from "./prescriptions";
import * as records from "./records";

const as = (role: Role) =>
  ({
    sessionId: "s",
    user: { id: "00000000-0000-0000-0000-000000000001", email: "t@example.org", name: "T", totpEnabled: false },
    organization: { id: "00000000-0000-0000-0000-000000000002", name: "P", slug: "p", smallBusiness: false, state: "BB" },
    role,
    can: (p) => can(role, p),
  }) as AuthContext;
const id = "00000000-0000-0000-0000-000000000003";

describe("Empfang (reception) ohne medizinische Rechte", () => {
  const r = as("reception");
  it("sieht keine Verordnungsdetails und kann nicht exportieren", async () => {
    await expect(prescriptions.listPatientPrescriptions(r, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prescriptions.billingBatchExport(r, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prescriptions.createBillingBatch(r, [id], { partner: "manual" })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("kann keine Verordnung, Doku oder Anamnese schreiben", async () => {
    await expect(prescriptions.changePrescriptionStatus(r, { id, patientId: id, to: "cancelled" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prescriptions.setCopaymentPaid(r, { id, patientId: id, paid: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(records.createTreatmentRecord(r, { patientId: id, findings: "x", servicesText: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(anamnesis.saveAnamnesis(r, id, {} as never, { updateRiskFlags: false })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("Übersicht ohne medizinische Details (redact)", () => {
    const vo = { diagnosisGroup: "DF", icd10: "E11.74", remedy: "Komplex", positions: [{ label: "x", units: 6 }], doctorName: "Dr. X", doctorLanr: "123456789", doctorBsnr: "123456789", interruptionNote: "n", scanMediaId: id, units: 6 };
    const red = prescriptions.redact(vo as never);
    expect(red).toMatchObject({ diagnosisGroup: "", icd10: null, positions: [], doctorLanr: null, scanMediaId: null, units: 6 });
  });
});

describe("Steuerberatung (accountant)", () => {
  const a = as("accountant");
  it("hat keinen Zugriff auf Pflegeheime, Anamnese, Verordnungen", async () => {
    await expect(careHomes.listCareHomes(a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(careHomes.saveCareHome(a, { name: "Heim" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(careHomes.visitDay(a, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(anamnesis.listAnamneses(a, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(anamnesis.createAnamnesisLink(a, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prescriptions.listRunningPrescriptions(a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prescriptions.listBillingBatches(a)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Azubi (trainee)", () => {
  it("darf dokumentieren, aber keine Pflegeheime/Links verwalten", async () => {
    const t = as("trainee");
    await expect(careHomes.assignResident(t, { careHomeId: id, patientId: id, billToHome: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(anamnesis.revokeAnamnesisLink(t, id, id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
