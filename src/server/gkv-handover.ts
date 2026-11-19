import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { billingBatches, billingBatchExports, billingBatchPayouts, gkvDeductions, prescriptions } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { deckblattPdf } from "@/lib/gkv-handover/deckblatt-pdf";
import {
  PAKET_SCHEMA,
  VERORDNUNGEN_ZUSATZ_KOPF,
  behandlungenZeilen,
  csvBytes,
  liesMich,
  paketJson,
  pruefsummenDatei,
  sha256Hex,
  sichererName,
  verordnungZusatz,
  type PaketMeta,
  type PaketVerordnung,
  type Unterschrift,
} from "@/lib/gkv-handover/paket";
import { AUSZAHLUNG_MAX_CENT, parseRueckmeldung, type RueckmeldungZeile } from "@/lib/gkv-handover/rueckmeldung";
import { cleanText, PRESCRIPTION_SPECIALS, type PrescriptionSpecial } from "@/lib/rules/gkv-billing";
import { normalizeId } from "@/lib/rules/gkv-ids";
import { exemptionSummary, THERAPY_REPORT_HPNR, type PriceSnapshot } from "@/lib/rules/prescription";
import { toZlHpnr } from "@/lib/rules/podologie-verguetung";
import { log } from "@/lib/log";
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";
import { assertCan } from "./authz";
import { copaymentPaidOn, batchCorrectionNote, batchCsvLine, GKV_BATCH_HEADER, loadBatchExport, markBatchExported, type BatchExportData } from "./prescriptions";
import { letterOrg, proofPdfInTx } from "./gkv-documents";
import { loadLogos } from "./practice-logos";
import { proofRows } from "./signatures";
import { therapyReportPdfInTx } from "./therapy-reports";

/**
 * GKV Paket E – neutrale Übergabe an ein beliebiges Abrechnungszentrum (docs/GKV-ABRECHNUNGSZENTRUM.md):
 *  - Übergabepaket je Abrechnungslauf (ZIP: verordnungen.csv, behandlungen.csv, abrechnungslauf.json, begleitzettel.pdf,
 *    Leistungsnachweise/Therapieberichte als PDF, PRUEFSUMMEN.sha256, LIESMICH.txt). Beim ersten Export erzeugt und
 *    verschlüsselt archiviert (billing_batch_exports, SHA-256); jeder weitere Download liefert genau diese Datei
 *    („Nachdruck“). Erzeugen, Ablegen, Archiv-Eintrag und Übergabevermerk in einer Transaktion unter Zeilensperre des
 *    Laufs – gleichzeitige Erst-Exporte warten aufeinander, es entsteht genau ein Archiv.
 *  - Rückmeldung einlesen (Auszahlung, Absetzungen): Vorschau ohne Änderung, Bestätigen mit derselben Datei (Prüfsumme);
 *    legt eine Auszahlung (billing_batch_payouts) und neue Absetzungen (gkv_deductions, Status „offen“) an. Verordnungen
 *    bleiben unverändert.
 * Rechte: invoices.write + medical.read (Diagnosen bzw. Zuordnung zu Personen), Kassenabrechnung aktiv; Support-Modus:
 * Downloads sperrt die Route (downloadAllowed), Änderungen (Rückmeldung, Auszahlung) hier. Audit ohne Gesundheitsdaten.
 */

export const HANDOVER_KIND = "handover_zip";

function access(auth: AuthContext): { error: string } | null {
  assertCan(auth, "invoices.write", "medical.read");
  return gkvGuard(auth.organization, "gkvBilling");
}

const SUPPORT_DENIED = "Im Support-Modus können Rückmeldungen und Auszahlungen nicht erfasst werden – das erledigt die Praxis selbst.";

const PARTNER: Record<string, string> = { manual: "manuell / noch offen", "opta-data": "opta data", optica: "Optica", azh: "azh / noventi", rzh: "RZH", other: "anderes" };

const baseName = (batch: { id: string; createdAt: Date }) => `Uebergabe-${berlinDateIso(batch.createdAt)}-${batch.id.slice(0, 8)}`;

// ───────────────────────── Übergabepaket ─────────────────────────

type BuiltPackage = { bytes: Buffer; count: number };

/** Positionsbezeichnung je Code (ZL-Nummer bzw. Rohwert) aus den Positionen der Verordnung */
function labels(positions: { position?: string | null; label: string }[]): Map<string, string> {
  const m = new Map<string, string>([[THERAPY_REPORT_HPNR, "Therapiebericht"]]);
  for (const p of positions) m.set(toZlHpnr(p.position) ?? p.position ?? p.label, p.label);
  return m;
}

/** Erzeugt das ZIP (in der laufenden Transaktion; liest nur). */
async function buildPackage(tx: Tx, org: string, data: BatchExportData, erzeugt: Date): Promise<BuiltPackage> {
  const o = await letterOrg(tx, org);
  if (!o) throw new Error("Praxis nicht gefunden.");
  const logos = await loadLogos(org, tx);
  const ids = data.rows.map((r) => r.vo.id);
  const proof = await proofRows(tx, org, ids);
  const meta: PaketMeta = {
    erzeugt: erzeugt.toISOString(),
    praxis: { name: o.legalName?.trim() || o.name, ik: o.ik ?? null, leistungserbringergruppe: data.org?.legsCode ?? null, strasse: o.street, plz: o.zip, ort: o.city },
    lauf: {
      id: data.batch.id,
      erstellt: data.batch.createdAt.toISOString(),
      frueherUebergeben: data.batch.exportedAt ? data.batch.exportedAt.toISOString() : null,
      abrechnungszentrum: PARTNER[data.batch.partner] ?? data.batch.partner,
      notiz: data.batch.note,
      anzahl: data.batch.prescriptionCount,
      heilmittelkostenCent: data.batch.remedyTotalCents,
      zuzahlungCent: data.batch.copaymentTotalCents ?? data.batch.totalCents,
    },
  };
  const files: { name: string; bytes: Buffer }[] = [];
  const vos: PaketVerordnung[] = [];
  const fehlend: string[] = [];
  let nachweise = 0;
  let berichte = 0;
  for (const row of data.rows) {
    const { vo, p } = row;
    const kurz = `${sichererName(vo.issuedAt)}_${vo.id.slice(0, 8)}`;
    let nachweis: string | null = null;
    let bericht: { name: string; datum: string } | null = null;
    const proofList = proof.get(vo.id) ?? [];
    try {
      if (proofList.length) {
        nachweis = `dokumente/leistungsnachweis/Leistungsnachweis_${kurz}.pdf`;
        files.push({ name: nachweis, bytes: Buffer.from(await proofPdfInTx(tx, org, vo, p, o, logos, erzeugt)) });
        nachweise++;
      } else fehlend.push(`Leistungsnachweis zu Verordnung ${vo.id.slice(0, 8)}: keine Behandlungseinträge`);
    } catch (e) {
      log.error("gkv_handover.proof_failed", { error: e, prescriptionId: vo.id });
      nachweis = null;
      fehlend.push(`Leistungsnachweis zu Verordnung ${vo.id.slice(0, 8)}: konnte nicht erzeugt werden`);
    }
    try {
      const r = await therapyReportPdfInTx(tx, org, { vo, p, o, logos });
      if (r) {
        bericht = { name: `dokumente/therapiebericht/Therapiebericht_${kurz}.pdf`, datum: r.reportDate };
        files.push({ name: bericht.name, bytes: Buffer.from(r.bytes) });
        berichte++;
      }
    } catch (e) {
      log.error("gkv_handover.report_failed", { error: e, prescriptionId: vo.id });
      fehlend.push(`Therapiebericht zu Verordnung ${vo.id.slice(0, 8)}: konnte nicht erzeugt werden`);
    }
    const snap = vo.priceSnapshot as PriceSnapshot | null;
    const namen = labels(vo.positions);
    vos.push({
      id: vo.id,
      status: vo.status,
      korrektur: batchCorrectionNote(data, vo.id),
      person: { nummer: p.number ?? null, nachname: p.lastName, vorname: p.firstName, geburtsdatum: p.birthDate, strasse: p.street, plz: p.zip, ort: p.city },
      versicherung: {
        krankenkasse: p.insurerName,
        kassenIk: vo.insurerIk ?? p.insurerIk ?? null,
        versichertennummer: vo.insuranceNumber || p.insuranceNumber || null,
        versichertenstatus: vo.insuredStatus ?? p.insuredStatus ?? null,
      },
      arzt: { name: vo.doctorName, lanr: vo.doctorLanr, bsnr: vo.doctorBsnr },
      ausstellungsdatum: vo.issuedAt,
      verordnungsart: vo.prescriptionKind,
      besonderheit: vo.prescriptionSpecial ? { code: vo.prescriptionSpecial, text: PRESCRIPTION_SPECIALS[vo.prescriptionSpecial as PrescriptionSpecial] ?? "" } : null,
      genehmigung: vo.approvalRef && vo.approvalDate ? { kennzeichen: vo.approvalRef, datum: vo.approvalDate } : null,
      diagnose: {
        gruppe: vo.diagnosisGroup,
        icd10: vo.icd10,
        icd10Zweit: vo.icd10Second,
        text: vo.diagnosisText,
        leitsymptomatik: vo.leitsymptomatik === "x" ? (vo.leitsymptomatikText ?? null) : (vo.leitsymptomatik ?? null),
      },
      heilmittel: vo.remedy,
      hausbesuch: vo.homeVisit,
      dringlich: vo.urgent,
      unfallfolgen: vo.accident,
      bvg: vo.bvg,
      therapieberichtAngefordert: vo.therapyReportRequested,
      einheitenVerordnet: vo.units,
      positionen: vo.positions.map((x) => ({ nummer: x.position ?? null, bezeichnung: x.label, einheiten: x.units })),
      behandlungen: proofList.map((r) => ({
        datum: r.date,
        unterschrift: (r.signature ? (r.signature.kind === "device" ? "geraet" : "papier") : "fehlt") as Unterschrift,
        nachgetragen: !!r.signature?.late,
      })),
      leistungen: (snap?.lines ?? []).map((l) => ({
        datum: l.date,
        position: l.position,
        bezeichnung: namen.get(l.position) ?? "",
        einheiten: l.units,
        einzelpreisCent: l.priceCents,
        zuzahlungCent: l.copayCents,
        befreit: l.exempt,
        minderjaehrig: l.minor,
        preisstand: l.tableVersion,
      })),
      heilmittelkostenCent: vo.remedyCostCents,
      zuzahlungCent: vo.copaymentCents,
      zuzahlungProzentCent: snap ? snap.copaymentPercentCents : null,
      verordnungsblattgebuehrCent: snap ? snap.flatFeeCents : null,
      zuzahlungsbefreit: exemptionSummary(snap),
      zuzahlungsfreiAngekreuzt: vo.copaymentExempt,
      zuzahlungErhaltenAm: copaymentPaidOn(data.receipts.get(vo.id), vo.copaymentPaidAt) || null,
      abbruchvermerk: vo.interruptionNote,
      regelwerk: vo.rulesVersion,
      therapiebericht: bericht ? { datum: bericht.datum } : null,
      dokumente: { leistungsnachweis: nachweis, therapiebericht: bericht?.name ?? null },
    });
  }
  const csvRows: unknown[][] = [[...GKV_BATCH_HEADER, ...VERORDNUNGEN_ZUSATZ_KOPF], ...data.rows.map((r, i) => [...batchCsvLine(data, r), ...verordnungZusatz(vos[i])])];
  files.push({ name: "verordnungen.csv", bytes: csvBytes(csvRows) });
  files.push({ name: "behandlungen.csv", bytes: csvBytes(behandlungenZeilen(data.batch.id, vos)) });
  files.push({ name: "abrechnungslauf.json", bytes: Buffer.from(`${JSON.stringify(paketJson(meta, vos), null, 2)}\n`, "utf8") });
  files.push({ name: "begleitzettel.pdf", bytes: Buffer.from(await deckblattPdf(meta, vos)) });
  files.push({ name: "LIESMICH.txt", bytes: Buffer.from(liesMich(meta, { verordnungen: vos.length, leistungsnachweise: nachweise, therapieberichte: berichte, fehlendeDokumente: fehlend }), "utf8") });
  files.push({ name: "PRUEFSUMMEN.sha256", bytes: Buffer.from(pruefsummenDatei(files), "utf8") });
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.bytes, { date: erzeugt });
  const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  return { bytes, count: vos.length };
}

export class HandoverIntegrityError extends Error {}

export type HandoverDownload = { bytes: Buffer; filename: string; sha256: string; reprint: boolean; afterFirstHandover: boolean; archivedAt: Date };

/** Archivierte Datei lesen und gegen die gespeicherte Prüfsumme prüfen (nie stillschweigend neu erzeugen); auch für den Praxis-Export */
export async function readArchive(org: string, a: { storageKey: string; sha256: string }): Promise<Buffer> {
  if (!a.storageKey.startsWith(`${org}/`) || a.storageKey.includes("..")) throw new HandoverIntegrityError("Speicherschlüssel gehört nicht zur Praxis.");
  const bytes = await readDecrypted(a.storageKey);
  if (sha256Hex(bytes) !== a.sha256) throw new HandoverIntegrityError("Prüfsumme des archivierten Übergabepakets stimmt nicht.");
  return bytes;
}

/**
 * Übergabepaket eines Abrechnungslaufs. Erster Abruf: erzeugen, verschlüsselt archivieren, Lauf als übergeben vermerken
 * (eine Transaktion, Zeilensperre auf dem Lauf). Jeder weitere Abruf: die archivierte Datei (byte-gleich, „Nachdruck“).
 * null = Lauf nicht gefunden.
 */
export async function handoverPackage(auth: AuthContext, batchId: string, opts: { format?: "zip" | "csv" } = {}): Promise<HandoverDownload | { error: string } | null> {
  const blocked = access(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  let written: string | null = null;
  let res: { archive: typeof billingBatchExports.$inferSelect; bytes: Buffer | null; batch: { id: string; createdAt: Date } } | null;
  try {
    res = await withOrg(org, async (tx) => {
      // gleichzeitige Erst-Exporte desselben Laufs warten hier aufeinander → genau ein Archiv
      const [batch] = await tx
        .select({ id: billingBatches.id, createdAt: billingBatches.createdAt })
        .from(billingBatches)
        .where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)))
        .for("update");
      if (!batch) return null;
      const [archive] = await tx
        .select()
        .from(billingBatchExports)
        .where(and(eq(billingBatchExports.organizationId, org), eq(billingBatchExports.billingBatchId, batchId), eq(billingBatchExports.kind, HANDOVER_KIND)));
      if (archive) return { archive, bytes: null, batch };
      const data = await loadBatchExport(tx, org, batchId);
      if (!data) return null;
      const built = await buildPackage(tx, org, data, new Date());
      const stored = await storeEncrypted(org, built.bytes);
      written = stored.storageKey;
      const [row] = await tx
        .insert(billingBatchExports)
        .values({
          organizationId: org,
          billingBatchId: batchId,
          kind: HANDOVER_KIND,
          storageKey: stored.storageKey,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          filename: `${baseName(batch)}.zip`,
          schemaVersion: PAKET_SCHEMA,
          prescriptionCount: built.count,
          createdBy: auth.user.id,
        })
        .returning();
      await markBatchExported(tx, org, batchId);
      await audit(
        { organizationId: org, userId: auth.user.id, action: "billing_batch.handover", entity: "billing_batch", entityId: batchId, meta: { reprint: false, format: opts.format ?? "zip", count: built.count, sizeBytes: stored.sizeBytes, sha256: stored.sha256, afterFirstHandover: row.afterFirstHandover } },
        tx,
      );
      return { archive: row, bytes: built.bytes, batch };
    });
  } catch (e) {
    // Datei liegt, aber der Archiv-Eintrag ist nicht gespeichert (Fehler nach dem Ablegen, auch beim COMMIT) → aufräumen,
    // nur wenn nachweislich nicht verzeichnet (sonst findet scripts/archive-orphans.ts sie)
    if (written) await discardIfUnreferenced(org, written);
    throw e;
  }
  if (!res) return null;
  const reprint = res.bytes === null;
  let bytes = res.bytes;
  if (!bytes) {
    try {
      bytes = await readArchive(org, res.archive);
    } catch (e) {
      log.error("gkv_handover.archive_unreadable", { error: e, batchId });
      return { error: "Das archivierte Übergabepaket ist nicht lesbar oder beschädigt – bitte den Support kontaktieren (es wird bewusst nicht neu erzeugt)." };
    }
    await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.handover", entity: "billing_batch", entityId: batchId, meta: { reprint: true, format: opts.format ?? "zip", sha256: res.archive.sha256 } });
  }
  return {
    bytes,
    filename: `${baseName(res.batch)}${reprint ? "-Nachdruck" : ""}.zip`,
    sha256: res.archive.sha256,
    reprint,
    afterFirstHandover: res.archive.afterFirstHandover,
    archivedAt: res.archive.createdAt,
  };
}

async function discardIfUnreferenced(org: string, key: string) {
  try {
    const [ref] = await withOrg(org, (tx) => tx.select({ id: billingBatchExports.id }).from(billingBatchExports).where(and(eq(billingBatchExports.organizationId, org), eq(billingBatchExports.storageKey, key))));
    if (!ref) await discardStored(key);
  } catch (e) {
    log.warn("gkv_handover.cleanup_skipped", { error: e });
  }
}

/** verordnungen.csv aus dem archivierten Übergabepaket (erster Abruf archiviert das Paket) */
export async function handoverCsv(auth: AuthContext, batchId: string): Promise<{ bytes: Buffer; filename: string; reprint: boolean } | { error: string } | null> {
  const pkg = await handoverPackage(auth, batchId, { format: "csv" });
  if (!pkg || "error" in pkg) return pkg;
  const zip = await JSZip.loadAsync(pkg.bytes);
  const f = zip.file("verordnungen.csv");
  if (!f) return { error: "Das Übergabepaket enthält keine verordnungen.csv." };
  return { bytes: Buffer.from(await f.async("uint8array")), filename: pkg.filename.replace(/^Uebergabe-/, "gkv-abrechnung-").replace(/\.zip$/, ".csv"), reprint: pkg.reprint };
}

export type PayoutRow = { id: string; amountCents: number; deductionCents: number; paidAt: string; reference: string | null; source: string; lineCount: number; createdAt: Date };

/** Lauf mit Archiv und Auszahlungen (Detailseite) */
export async function batchHandoverInfo(auth: AuthContext, batchId: string) {
  const blocked = access(auth);
  if (blocked) return null;
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [batch] = await tx.select().from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    if (!batch) return null;
    const [archive] = await tx
      .select({ sha256: billingBatchExports.sha256, sizeBytes: billingBatchExports.sizeBytes, createdAt: billingBatchExports.createdAt, afterFirstHandover: billingBatchExports.afterFirstHandover, filename: billingBatchExports.filename, schemaVersion: billingBatchExports.schemaVersion })
      .from(billingBatchExports)
      .where(and(eq(billingBatchExports.organizationId, org), eq(billingBatchExports.billingBatchId, batchId), eq(billingBatchExports.kind, HANDOVER_KIND)));
    const payouts: PayoutRow[] = await tx
      .select({
        id: billingBatchPayouts.id,
        amountCents: billingBatchPayouts.amountCents,
        deductionCents: billingBatchPayouts.deductionCents,
        paidAt: billingBatchPayouts.paidAt,
        reference: billingBatchPayouts.reference,
        source: billingBatchPayouts.source,
        lineCount: billingBatchPayouts.lineCount,
        createdAt: billingBatchPayouts.createdAt,
      })
      .from(billingBatchPayouts)
      .where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.billingBatchId, batchId)))
      .orderBy(asc(billingBatchPayouts.paidAt), asc(billingBatchPayouts.createdAt));
    const copay = batch.copaymentTotalCents ?? batch.totalCents;
    return {
      batch,
      archive: archive ?? null,
      payouts,
      sollInsurerCents: batch.remedyTotalCents === null ? null : batch.remedyTotalCents - copay,
      paidCents: payouts.reduce((s, p) => s + p.amountCents, 0),
      deductionCents: payouts.reduce((s, p) => s + p.deductionCents, 0),
    };
  });
}

// ───────────────────────── Rückmeldung (Auszahlung, Absetzungen) ─────────────────────────

export type PayoutPreviewLine = {
  zeile: number;
  prescriptionId: string;
  patientId: string;
  person: string;
  ausstellungsdatum: string;
  /** Kassenanteil laut Lauf (Heilmittelkosten − Zuzahlung), null = ohne Heilmittelkosten */
  sollCent: number | null;
  ausgezahltCent: number;
  absetzung: RueckmeldungZeile["absetzung"];
  /** gleiche Absetzung (Betrag, Code) zu dieser Verordnung ist schon erfasst → wird nicht erneut angelegt */
  absetzungVorhanden: boolean;
  hinweise: string[];
};

export type PayoutPreview = {
  sha256: string;
  dateiname: string;
  format: "csv" | "json" | null;
  auszahlungsdatum: string | null;
  sammelrechnungsnummer: string | null;
  fehler: string[];
  zeilen: PayoutPreviewLine[];
  /** Zeilen mit anderer Lauf-ID (übersprungen) */
  andererLauf: number;
  summeAusgezahltCent: number;
  summeAbsetzungCent: number;
  /** diese Datei ist für diesen Lauf schon eingelesen */
  bereitsEingelesen: boolean;
};

/** Zuordnung der geprüften Zeilen zu den Verordnungen des Laufs (wie im Übergabepaket) – liest nur */
async function matchRueckmeldung(tx: Tx, org: string, batchId: string, bytes: Uint8Array, dateiname: string): Promise<PayoutPreview | { error: string }> {
  const [batch] = await tx.select({ exportedAt: billingBatches.exportedAt }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
  if (!batch) return { error: "Abrechnungslauf nicht gefunden." };
  if (!batch.exportedAt) return { error: "Rückmeldungen gibt es nur zu übergebenen Abrechnungsläufen – bitte zuerst das Übergabepaket herunterladen." };
  const parsed = parseRueckmeldung(bytes, dateiname, berlinDateIso());
  const preview: PayoutPreview = {
    sha256: parsed.sha256,
    dateiname: cleanText(dateiname, 120),
    format: parsed.format,
    auszahlungsdatum: parsed.auszahlungsdatum,
    sammelrechnungsnummer: parsed.sammelrechnungsnummer,
    fehler: [...parsed.fehler],
    zeilen: [],
    andererLauf: 0,
    summeAusgezahltCent: 0,
    summeAbsetzungCent: 0,
    bereitsEingelesen: false,
  };
  const [dup] = await tx
    .select({ id: billingBatchPayouts.id })
    .from(billingBatchPayouts)
    .where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.billingBatchId, batchId), eq(billingBatchPayouts.sourceSha256, parsed.sha256)));
  preview.bereitsEingelesen = !!dup;
  if (parsed.fehler.length) return preview;
  const data = await loadBatchExport(tx, org, batchId);
  if (!data) return { error: "Abrechnungslauf nicht gefunden." };
  const byId = new Map(data.rows.map((r) => [r.vo.id, r]));
  const byKey = new Map<string, BatchExportData["rows"][number][]>();
  for (const r of data.rows) {
    const k = `${normalizeId(r.vo.insuranceNumber || r.p.insuranceNumber)}|${r.vo.issuedAt}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  // aktueller Stand (Absetzung nur zu abgerechneten Verordnungen) und vorhandene Absetzungen
  const ids = data.rows.map((r) => r.vo.id);
  const current = ids.length
    ? new Map(
        (await tx.select({ id: prescriptions.id, status: prescriptions.status, billedAt: prescriptions.billedAt }).from(prescriptions).where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.id, ids)))).map((r) => [r.id, r]),
      )
    : new Map();
  const existing = ids.length
    ? await tx
        .select({ prescriptionId: gkvDeductions.prescriptionId, amountCents: gkvDeductions.amountCents, reasonCode: gkvDeductions.reasonCode })
        .from(gkvDeductions)
        .where(and(eq(gkvDeductions.organizationId, org), inArray(gkvDeductions.prescriptionId, ids)))
    : [];
  const zugeordnet = new Map<string, number>();
  const praefix = (z: RueckmeldungZeile) => `${parsed.format === "json" ? "Position" : "Zeile"} ${z.zeile}`;
  for (const z of parsed.zeilen) {
    if (z.laufId && z.laufId !== batchId) {
      preview.andererLauf++;
      continue;
    }
    let row: BatchExportData["rows"][number] | undefined;
    if (z.verordnungId) {
      row = byId.get(z.verordnungId);
      if (!row) {
        preview.fehler.push(`${praefix(z)}: Verordnung ist nicht in diesem Abrechnungslauf`);
        continue;
      }
      if (z.versichertennummer && normalizeId(row.vo.insuranceNumber || row.p.insuranceNumber) !== z.versichertennummer) {
        preview.fehler.push(`${praefix(z)}: Versichertennummer passt nicht zur Verordnung`);
        continue;
      }
      if (z.ausstellungsdatum && z.ausstellungsdatum !== row.vo.issuedAt) {
        preview.fehler.push(`${praefix(z)}: Ausstellungsdatum passt nicht zur Verordnung`);
        continue;
      }
    } else {
      const treffer = byKey.get(`${z.versichertennummer}|${z.ausstellungsdatum}`) ?? [];
      if (treffer.length !== 1) {
        preview.fehler.push(`${praefix(z)}: ${treffer.length ? "mehrere Verordnungen mit dieser Versichertennummer und diesem Ausstellungsdatum – bitte Verordnung-ID angeben" : "keine Verordnung mit dieser Versichertennummer und diesem Ausstellungsdatum in diesem Abrechnungslauf"}`);
        continue;
      }
      row = treffer[0];
    }
    const vorher = zugeordnet.get(row.vo.id);
    if (vorher !== undefined) {
      preview.fehler.push(`${praefix(z)}: Verordnung bereits in ${parsed.format === "json" ? "Position" : "Zeile"} ${vorher} zugeordnet`);
      continue;
    }
    zugeordnet.set(row.vo.id, z.zeile);
    const cur = current.get(row.vo.id);
    if (z.absetzung && !(cur && (cur.billedAt || cur.status === "billed" || cur.status === "correction_needed"))) {
      preview.fehler.push(`${praefix(z)}: Absetzung nicht möglich – die Verordnung ist derzeit nicht abgerechnet`);
      continue;
    }
    const soll = row.vo.remedyCostCents === null ? null : row.vo.remedyCostCents - (row.vo.copaymentCents ?? 0);
    const hinweise: string[] = [];
    if (soll !== null && z.ausgezahltCent + (z.absetzung?.betragCent ?? 0) !== soll)
      hinweise.push(`Ausgezahlt + Absetzung weicht vom Kassenanteil laut Lauf ab (${((z.ausgezahltCent + (z.absetzung?.betragCent ?? 0) - soll) / 100).toFixed(2).replace(".", ",")} €)`);
    if (z.absetzung && !z.absetzung.code) hinweise.push("Absetzung ohne Code");
    const absetzungVorhanden = !!z.absetzung && existing.some((d) => d.prescriptionId === row!.vo.id && d.amountCents === z.absetzung!.betragCent && (d.reasonCode ?? null) === z.absetzung!.code);
    preview.zeilen.push({
      zeile: z.zeile,
      prescriptionId: row.vo.id,
      patientId: row.p.id,
      person: `${[row.p.firstName, row.p.lastName].filter(Boolean).join(" ")} (#${row.p.number})`,
      ausstellungsdatum: row.vo.issuedAt,
      sollCent: soll,
      ausgezahltCent: z.ausgezahltCent,
      absetzung: z.absetzung,
      absetzungVorhanden,
      hinweise,
    });
    preview.summeAusgezahltCent += z.ausgezahltCent;
    preview.summeAbsetzungCent += z.absetzung?.betragCent ?? 0;
  }
  if (!preview.fehler.length && !preview.zeilen.length) preview.fehler.push("Keine Zeile gehört zu diesem Abrechnungslauf.");
  if (preview.summeAusgezahltCent > 100_000_000 || preview.summeAbsetzungCent > 100_000_000) preview.fehler.push("Summe über 1 Mio. € – bitte prüfen.");
  if (preview.fehler.length) preview.zeilen = [];
  return preview;
}

const MAX_NAME = 200;

/** Vorschau einer Rückmeldung: prüft und ordnet zu, ändert nichts. */
export async function previewPayoutImport(auth: AuthContext, batchId: string, bytes: Uint8Array, dateiname: string): Promise<PayoutPreview | { error: string }> {
  const blocked = access(auth);
  if (blocked) return blocked;
  if (auth.support) return { error: SUPPORT_DENIED };
  const org = auth.organization.id;
  const res = await withOrg(org, (tx) => matchRueckmeldung(tx, org, batchId, bytes, dateiname.slice(0, MAX_NAME)));
  if (!("error" in res)) {
    await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.payout_preview", entity: "billing_batch", entityId: batchId, meta: { lines: res.zeilen.length, errors: res.fehler.length, otherBatch: res.andererLauf, sha256: res.sha256 } });
  }
  return res;
}

/**
 * Rückmeldung übernehmen – nur mit derselben Datei wie in der Vorschau (Prüfsumme) und ohne Fehler: eine Auszahlung
 * (Summe der Zeilen dieses Laufs) und neue Absetzungen (Status „offen“, Kassenschreiben = Sammelrechnungsnummer). Bereits
 * erfasste gleiche Absetzungen werden übersprungen. Verordnungen bleiben unverändert.
 */
export async function confirmPayoutImport(
  auth: AuthContext,
  batchId: string,
  bytes: Uint8Array,
  dateiname: string,
  expectedSha256: string,
): Promise<{ payoutId: string; deductions: number; skippedDeductions: number } | { error: string }> {
  const blocked = access(auth);
  if (blocked) return blocked;
  if (auth.support) return { error: SUPPORT_DENIED };
  const org = auth.organization.id;
  if (sha256Hex(bytes) !== expectedSha256) return { error: "Die Datei wurde seit der Vorschau geändert – bitte erneut prüfen." };
  try {
    return await withOrg(org, async (tx) => {
      // je Lauf nacheinander (gleichzeitiges Einlesen derselben Datei scheitert zusätzlich am eindeutigen Index)
      const [locked] = await tx.select({ id: billingBatches.id }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId))).for("update");
      if (!locked) return { error: "Abrechnungslauf nicht gefunden." };
      const p = await matchRueckmeldung(tx, org, batchId, bytes, dateiname.slice(0, MAX_NAME));
      if ("error" in p) return p;
      if (p.bereitsEingelesen) return { error: "Diese Rückmeldung ist für diesen Abrechnungslauf bereits eingelesen." };
      if (p.fehler.length || !p.zeilen.length || !p.auszahlungsdatum) return { error: `Die Rückmeldung enthält Fehler – bitte die Vorschau prüfen.${p.fehler.length ? ` (${p.fehler[0]})` : ""}` };
      const [payout] = await tx
        .insert(billingBatchPayouts)
        .values({
          organizationId: org,
          billingBatchId: batchId,
          amountCents: p.summeAusgezahltCent,
          deductionCents: p.summeAbsetzungCent,
          paidAt: p.auszahlungsdatum,
          reference: p.sammelrechnungsnummer,
          source: "import",
          sourceSha256: p.sha256,
          lineCount: p.zeilen.length,
          details: p.zeilen.map((z) => ({ prescriptionId: z.prescriptionId, paidCents: z.ausgezahltCent, deductionCents: z.absetzung?.betragCent ?? 0 })),
          createdBy: auth.user.id,
        })
        .returning({ id: billingBatchPayouts.id });
      const neu = p.zeilen.filter((z) => z.absetzung && !z.absetzungVorhanden);
      if (neu.length) {
        await tx.insert(gkvDeductions).values(
          neu.map((z) => ({
            organizationId: org,
            prescriptionId: z.prescriptionId,
            patientId: z.patientId,
            billingBatchId: batchId,
            payoutId: payout.id,
            amountCents: z.absetzung!.betragCent,
            reasonCode: z.absetzung!.code,
            reason: z.absetzung!.grund,
            deductedOn: p.auszahlungsdatum!,
            letterRef: p.sammelrechnungsnummer,
            note: "aus Rückmeldung des Abrechnungszentrums eingelesen",
            createdBy: auth.user.id,
          })),
        );
      }
      const skipped = p.zeilen.filter((z) => z.absetzung && z.absetzungVorhanden).length;
      // Audit ohne Gründe/Namen: Anzahlen, Summen, Prüfsumme der Datei
      await audit(
        {
          organizationId: org,
          userId: auth.user.id,
          action: "billing_batch.payout_import",
          entity: "billing_batch",
          entityId: batchId,
          meta: { payoutId: payout.id, lines: p.zeilen.length, amountCents: p.summeAusgezahltCent, deductionCents: p.summeAbsetzungCent, deductions: neu.length, skippedDeductions: skipped, otherBatch: p.andererLauf, sha256: p.sha256 },
        },
        tx,
      );
      return { payoutId: payout.id, deductions: neu.length, skippedDeductions: skipped };
    });
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
    if (code === "23505") return { error: "Diese Rückmeldung ist für diesen Abrechnungslauf bereits eingelesen." };
    throw e;
  }
}

export const manualPayoutInput = z.object({
  batchId: z.string().uuid(),
  amountCents: z.coerce.number().int("Betrag ungültig.").min(1, "Betrag muss größer als 0 sein.").max(AUSZAHLUNG_MAX_CENT * 10, "Betrag über 1 Mio. € – bitte prüfen."),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum der Auszahlung ungültig."),
  reference: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 80) || null : v ?? null), z.string().max(60, "Referenz: höchstens 60 Zeichen.").nullable()),
});
export type ManualPayoutInput = z.infer<typeof manualPayoutInput>;

/** Auszahlung von Hand erfassen (ohne Datei des Abrechnungszentrums) – nur zu einem übergebenen Lauf. */
export async function recordManualPayout(auth: AuthContext, input: ManualPayoutInput): Promise<{ id: string } | { error: string }> {
  const blocked = access(auth);
  if (blocked) return blocked;
  if (auth.support) return { error: SUPPORT_DENIED };
  const parsed = manualPayoutInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingabe ungültig." };
  const d = parsed.data;
  const real = new Date(`${d.paidAt}T00:00:00Z`);
  if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== d.paidAt || d.paidAt < "2000-01-01") return { error: "Datum der Auszahlung ungültig." };
  if (d.paidAt > berlinDateIso()) return { error: "Das Datum der Auszahlung liegt in der Zukunft." };
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [b] = await tx.select({ exportedAt: billingBatches.exportedAt }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, d.batchId)));
    if (!b) return { error: "Abrechnungslauf nicht gefunden." };
    if (!b.exportedAt) return { error: "Auszahlungen gibt es nur zu übergebenen Abrechnungsläufen." };
    const [row] = await tx
      .insert(billingBatchPayouts)
      .values({ organizationId: org, billingBatchId: d.batchId, amountCents: d.amountCents, paidAt: d.paidAt, reference: d.reference, source: "manual", createdBy: auth.user.id })
      .returning({ id: billingBatchPayouts.id });
    await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.payout_manual", entity: "billing_batch", entityId: d.batchId, meta: { payoutId: row.id, amountCents: d.amountCents, paidAt: d.paidAt } }, tx);
    return { id: row.id };
  });
  return res;
}

/** Auszahlungen je Lauf (Übersicht) – Summe und letzte Auszahlung */
export async function payoutTotals(auth: AuthContext): Promise<Map<string, { cents: number; count: number; last: string | null }>> {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ batchId: billingBatchPayouts.billingBatchId, amountCents: billingBatchPayouts.amountCents, paidAt: billingBatchPayouts.paidAt })
      .from(billingBatchPayouts)
      .where(eq(billingBatchPayouts.organizationId, org))
      .orderBy(desc(billingBatchPayouts.paidAt)),
  );
  const out = new Map<string, { cents: number; count: number; last: string | null }>();
  for (const r of rows) {
    const cur = out.get(r.batchId) ?? { cents: 0, count: 0, last: r.paidAt };
    cur.cents += r.amountCents;
    cur.count++;
    out.set(r.batchId, cur);
  }
  return out;
}
