import { describe, expect, it } from "vitest";
import { afterPrescriptionWarning, followUpLetter, followUpReason } from "./follow-up";

const base = { unitsUsed: 6, unitsRemaining: 0, futureAppointments: 0, followUpExpected: false, newerPrescription: false };

describe("Folgeverordnung: Hinweis", () => {
  it("beendet bzw. letzte Einheit + Termine oder Dauerpatient:in", () => {
    expect(followUpReason({ ...base, status: "completed" })).toBeNull();
    expect(followUpReason({ ...base, status: "completed", futureAppointments: 1 })).toBe("ended");
    expect(followUpReason({ ...base, status: "billed", followUpExpected: true })).toBe("ended");
    expect(followUpReason({ ...base, status: "billing_ready", followUpExpected: true, newerPrescription: true })).toBeNull();
    expect(followUpReason({ ...base, status: "active", unitsUsed: 5, unitsRemaining: 1, futureAppointments: 2 })).toBe("last_unit");
    expect(followUpReason({ ...base, status: "active", unitsUsed: 4, unitsRemaining: 2, futureAppointments: 2 })).toBeNull();
    expect(followUpReason({ ...base, status: "open", unitsUsed: 0, unitsRemaining: 1, futureAppointments: 2 })).toBeNull();
    expect(followUpReason({ ...base, status: "cancelled", futureAppointments: 2 })).toBeNull();
    // Frist überschritten nach mindestens einer Behandlung: ebenfalls beendet (Review R2-23)
    expect(followUpReason({ ...base, status: "expired", unitsUsed: 2, unitsRemaining: 4, futureAppointments: 1 })).toBe("ended");
    expect(followUpReason({ ...base, status: "expired", unitsUsed: 0, unitsRemaining: 6, futureAppointments: 1 })).toBeNull();
  });

  it("Planungshinweis nur für Termine nach der letzten Behandlung einer beendeten Verordnung", () => {
    const last = { issuedAt: "2026-09-01", status: "completed", lastDate: "2026-11-02" };
    expect(afterPrescriptionWarning({ lastPrescription: last, newDates: ["2026-11-20"] })).toMatch(/Termin 20\.11\.2026 nach Ende der Verordnung vom 01\.09\.2026 \(letzte Behandlung 02\.11\.2026\)/);
    expect(afterPrescriptionWarning({ lastPrescription: last, newDates: ["2026-10-20"] })).toBeNull();
    expect(afterPrescriptionWarning({ lastPrescription: { ...last, status: "active" }, newDates: ["2026-11-20"] })).toBeNull();
    expect(afterPrescriptionWarning({ lastPrescription: null, newDates: ["2026-11-20"] })).toBeNull();
  });

  it("Brieftext mit Diagnose/ICD, Verlauf aus dem Therapiebericht und Behandlungszeitraum", () => {
    const l = followUpLetter({
      practice: "Praxis Fußwohl",
      doctorName: "Dr. Beispiel",
      patient: { name: "Erika Musterfrau", birthDate: "1950-03-01", insuranceNumber: "A000500015", insurerName: "Beispiel-BKK" },
      prescription: { issuedAt: "2026-08-01", diagnosisGroup: "DF", icd10: "E11.74", positions: [{ position: "78020", label: "groß", units: 6 }], units: 6 },
      treatmentDates: ["2026-08-05", "2026-10-30"],
      report: { reportDate: "2026-11-01", course: "rückläufig", result: null, recommendation: "Fortsetzung alle 4 Wochen" },
      today: "2026-11-18",
    });
    expect(l.subject).toBe("Anforderung einer Folgeverordnung (Podologie) – Erika Musterfrau");
    const all = l.paragraphs.join("\n");
    expect(all).toMatch(/Sehr geehrte\/r Dr\. Beispiel/);
    expect(all).toMatch(/DF, ICD-10 E11\.74/);
    expect(all).toMatch(/2 Tagen \(05\.08\.2026 bis 30\.10\.2026\) von 6/);
    expect(all).toMatch(/Therapiebericht vom 01\.11\.2026: Verlauf: rückläufig Empfehlung: Fortsetzung alle 4 Wochen/);
  });
});
