import "server-only";
import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { organizations, patients, prescriptions, therapyReports } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { renderProofPdf, type GkvPdfOrg, type GkvPdfPatient, type GkvPdfPrescription, type ProofPdfRow } from "@/lib/gkv-pdf";
import { practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { priceSnapshot, type PriceSnapshot } from "@/lib/rules/prescription";
import { SIGNER_ROLE_LABEL } from "@/lib/signature";
import { assertCan } from "./authz";
import { loadLogos } from "./practice-logos";
import { proofRows, signatureImages } from "./signatures";

/** Praxis als Briefkopf (Fußzeile wie Rechnungen) inkl. IK */
export async function letterOrg(tx: Tx, org: string): Promise<GkvPdfOrg | null> {
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  if (!o) return null;
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const doc = readDocumentSettings(settings);
  return {
    name: o.name,
    legalName: o.legalName,
    street: o.street,
    zip: o.zip,
    city: o.city,
    phone: o.phone,
    email: o.email,
    taxNumber: o.taxNumber,
    vatId: o.vatId,
    iban: o.iban,
    bic: o.bic,
    bankName: o.bankName,
    accountHolder: o.accountHolder,
    website: practiceWebsite(settings),
    qualification: doc.qualification,
    whatsapp: doc.whatsapp,
    ik: o.ik,
  };
}

export const pdfPatient = (p: typeof patients.$inferSelect, vo: Pick<typeof prescriptions.$inferSelect, "insurerIk" | "insuranceNumber">): GkvPdfPatient => ({
  name: [p.title, p.firstName, p.lastName].filter(Boolean).join(" "),
  birthDate: p.birthDate,
  insuranceNumber: vo.insuranceNumber ?? p.insuranceNumber,
  insurerName: p.insurerName,
  insurerIk: vo.insurerIk ?? p.insurerIk,
  number: p.number,
});

export const pdfPrescription = (vo: typeof prescriptions.$inferSelect): GkvPdfPrescription => ({
  issuedAt: vo.issuedAt,
  doctorName: vo.doctorName,
  doctorLanr: vo.doctorLanr,
  doctorBsnr: vo.doctorBsnr,
  diagnosisGroup: vo.diagnosisGroup,
  icd10: vo.icd10,
  icd10Second: vo.icd10Second,
  diagnosisText: vo.diagnosisText,
  units: vo.units,
  positions: vo.positions,
});

/** Verordnung + Person laden (gehört die Verordnung zur Person?) */
export async function loadPrescriptionWithPatient(tx: Tx, org: string, prescriptionId: string, patientId?: string) {
  const [row] = await tx
    .select({ vo: prescriptions, p: patients })
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, prescriptionId), ...(patientId ? [eq(prescriptions.patientId, patientId)] : [])));
  return row ?? null;
}

/**
 * Positionen je Behandlungstag: aus dem Preis-Snapshot (Abrechnungsreife), sonst nach derselben Zuordnung berechnet
 * (priceSnapshot, zeitliche Reihenfolge) – so passt der Leistungsnachweis zur Abrechnung.
 */
export function positionsByDay(
  vo: Pick<typeof prescriptions.$inferSelect, "positions" | "priceSnapshot" | "insurerIk" | "interruptionNote" | "units">,
  dates: string[],
  birthDate: string | null,
  therapyReportDate: string | null = null,
): Map<string, { text: string; units: number }> {
  const stored = vo.priceSnapshot as PriceSnapshot | null;
  const snap = stored?.lines?.length
    ? stored
    : priceSnapshot({ positions: vo.positions, treatmentDates: dates, birthDate, exemptions: [], computedOn: berlinDateIso(), insurerIk: vo.insurerIk, endedEarly: !!vo.interruptionNote && dates.length < vo.units, therapyReportDate });
  const out = new Map<string, { text: string; units: number }>();
  for (const l of snap.lines) {
    const cur = out.get(l.date) ?? { text: "", units: 0 };
    cur.text = [cur.text, `${l.position} × ${l.units}`].filter(Boolean).join(", ");
    cur.units += l.units;
    out.set(l.date, cur);
  }
  return out;
}

type VoRow = typeof prescriptions.$inferSelect;
type PatientRow = typeof patients.$inferSelect;
type Logos = Awaited<ReturnType<typeof loadLogos>>;

/** Behandlungen mit Unterschriften, Bilder und Berichtsdatum für den Leistungsnachweis (in der laufenden Transaktion) */
async function loadProof(tx: Tx, org: string, prescriptionId: string) {
  const rows = (await proofRows(tx, org, [prescriptionId])).get(prescriptionId) ?? [];
  const images = await signatureImages(tx, org, rows.flatMap((r) => (r.signature?.kind === "device" ? [r.signature.id] : [])));
  const [report] = await tx.select({ reportDate: therapyReports.reportDate }).from(therapyReports).where(and(eq(therapyReports.organizationId, org), eq(therapyReports.prescriptionId, prescriptionId)));
  return { rows, images, reportDate: report?.reportDate ?? null };
}

async function renderProof(vo: VoRow, p: PatientRow, d: Awaited<ReturnType<typeof loadProof>>, o: GkvPdfOrg, logos: Logos, generatedAt: Date) {
  const byDay = positionsByDay(vo, [...new Set(d.rows.map((r) => r.date))], p.birthDate, d.reportDate);
  // mehrere Einträge am selben Tag: Positionen des Tages nur in der ersten Zeile (Snapshot je Tag eindeutig)
  const seen = new Set<string>();
  const pdfRows: ProofPdfRow[] = d.rows.map((r) => {
    const first = !seen.has(r.date);
    seen.add(r.date);
    const day = first ? byDay.get(r.date) : undefined;
    return {
      date: r.date,
      positions: day?.text ?? (first ? "" : "(siehe oben, gleicher Tag)"),
      units: day?.units ?? 0,
      signature: r.signature
        ? { kind: r.signature.kind, image: r.signature.kind === "device" ? (d.images.get(r.signature.id) ?? null) : null, signerName: r.signature.signerName, roleLabel: r.signature.signerRole ? SIGNER_ROLE_LABEL[r.signature.signerRole] : null, signedAt: r.signature.signedAt, late: r.signature.late }
        : null,
    };
  });
  const bytes = await renderProofPdf({ organization: o, logos, patient: pdfPatient(p, vo), prescription: pdfPrescription(vo), rows: pdfRows, generatedAt });
  return { bytes, pdfRows };
}

/**
 * Leistungsnachweis-PDF in einer laufenden Transaktion, ohne Audit – für das Übergabepaket eines Abrechnungslaufs (GKV
 * Paket E; der Aufrufer prüft Rechte und protokolliert). `vo` darf der Stand der Erstabrechnung sein (original_row).
 */
export async function proofPdfInTx(tx: Tx, org: string, vo: VoRow, p: PatientRow, o: GkvPdfOrg, logos: Logos, generatedAt = new Date()): Promise<Uint8Array> {
  return (await renderProof(vo, p, await loadProof(tx, org, vo.id), o, logos, generatedAt)).bytes;
}

/** Leistungsnachweis-PDF je Verordnung (Recht medical.read; Aufrufer prüft Download im Support-Modus) */
export async function proofPdf(auth: AuthContext, prescriptionId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  assertCan(auth, "medical.read");
  if (gkvGuard(auth.organization, "verordnungen")) return null;
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const row = await loadPrescriptionWithPatient(tx, org, prescriptionId);
    if (!row) return null;
    const o = await letterOrg(tx, org);
    if (!o) return null;
    return { ...row, o, proof: await loadProof(tx, org, prescriptionId) };
  });
  if (!data) return null;
  const logos = await loadLogos(org);
  const { bytes, pdfRows } = await renderProof(data.vo, data.p, data.proof, data.o, logos, new Date());
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.proof_pdf", entity: "prescription", entityId: prescriptionId, meta: { patientId: data.p.id, rows: pdfRows.length, missing: pdfRows.filter((r) => !r.signature).length } });
  return { bytes, filename: `Leistungsnachweis-${data.vo.issuedAt}-${prescriptionId.slice(0, 8)}.pdf` };
}
