import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderProofPdf } from "./gkv-pdf";

const org = { name: "Praxis Fußwohl", legalName: null, street: "Musterweg 1", zip: "14467", city: "Potsdam", phone: null, email: null, taxNumber: null, vatId: null, iban: null, ik: "109911114" };
const patient = { name: "Erika Musterfrau", birthDate: "1950-03-01", insuranceNumber: "A000500015", insurerName: "Beispiel-BKK", insurerIk: "109911114" };
const vo = { issuedAt: "2026-11-02", doctorName: "Dr. Beispiel", doctorLanr: "123456601", doctorBsnr: "123456789", diagnosisGroup: "DF", icd10: "E11.74", units: 6, positions: [{ position: "78020", label: "Podologische Behandlung (groß)", units: 6 }] };

describe("Leistungsnachweis-PDF", () => {
  it("viele Behandlungen → mehrere Seiten; Zeilen ohne Unterschrift, Papier-Vermerk, kaputtes Bild brechen nichts", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
      positions: "78020 × 1",
      units: 1,
      signature: i % 3 === 0 ? null : i % 3 === 1 ? { kind: "paper" as const, signerName: null, roleLabel: null, signedAt: new Date() } : { kind: "device" as const, image: new Uint8Array([1, 2, 3]), signerName: "Paul Pflege", roleLabel: "Betreuungsperson", signedAt: new Date() },
    }));
    const bytes = await renderProofPdf({ organization: org, patient, prescription: vo, rows, generatedAt: new Date() });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Leistungsnachweis Verordnung vom 02.11.2026");
  });
});

describe("Therapiebericht- und Anforderungs-PDF", () => {
  it("Therapiebericht mit langen Abschnitten → gültiges PDF, ggf. mehrseitig", async () => {
    const { renderTherapyReportPdf } = await import("./gkv-pdf");
    const bytes = await renderTherapyReportPdf({
      organization: org,
      patient,
      prescription: vo,
      report: { reportDate: "2026-11-15", findings: "Unguis incarnatus D1 re. ".repeat(80), course: "gut", result: null, recommendation: "Fortsetzung", notes: null, author: "Anna Test" },
      treatmentDates: ["2026-11-02", "2026-11-09"],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("Therapiebericht Erika Musterfrau – Verordnung vom 02.11.2026");
  });
  it("Anforderung Folgeverordnung", async () => {
    const { renderFollowUpPdf } = await import("./gkv-pdf");
    const bytes = await renderFollowUpPdf({ organization: org, prescription: vo, letter: { subject: "Anforderung einer Folgeverordnung (Podologie) – Erika Musterfrau", paragraphs: ["Sehr geehrte/r Dr. Beispiel,", "Text"] }, date: "2026-11-18" });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
