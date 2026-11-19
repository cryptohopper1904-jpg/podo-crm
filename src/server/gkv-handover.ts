import "server-only";
import { createHash } from "node:crypto";
import { pipeline, Readable, Transform } from "node:stream";
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
  HANDOVER_MAX_BYTES,
  PAKET_SCHEMA,
  paketGrenze,
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
import { discardStored, readDecrypted, readDecryptedStream, storeEncrypted } from "@/lib/storage";
import { assertCan } from "./authz";
import { copaymentPaidOn, batchCorrectionNote, batchCsvLine, GKV_BATCH_HEADER, loadBatchExport, markBatchExported, type BatchExportData } from "./prescriptions";
import { letterOrg, proofPdfInTx } from "./gkv-documents";
import { loadLogos } from "./practice-logos";
import { proofRows } from "./signatures";
import { reportsFor, therapyReportPdfInTx } from "./therapy-reports";

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

type BuiltPackage = { bytes: Buffer; count: number; missing: number };

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
  const reports = await reportsFor(tx, org, ids);
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
    // volle Verordnungs-ID im Dateinamen (eindeutig, Code-Review K7)
    const kurz = `${sichererName(vo.issuedAt)}_${vo.id}`;
    let nachweis: string | null = null;
    let bericht: { name: string; datum: string } | null = null;
    const proofList = proof.get(vo.id) ?? [];
    // Technische Fehler (Unterschrift nicht lesbar, PDF-Fehler) werfen: die Transaktion rollt zurück, nichts wird
    // archiviert, ein Neuversuch ist möglich (Code-Review A). „Fehlend“ nur, was fachlich fehlt.
    if (proofList.length) {
      nachweis = `dokumente/leistungsnachweis/Leistungsnachweis_${kurz}.pdf`;
      files.push({ name: nachweis, bytes: Buffer.from(await proofPdfInTx(tx, org, vo, p, o, logos, erzeugt, proofList)) });
      nachweise++;
    } else fehlend.push(`Leistungsnachweis zu Verordnung ${vo.id.slice(0, 8)}: keine Behandlungseinträge`);
    if (reports.has(vo.id)) {
      const r = await therapyReportPdfInTx(tx, org, { vo, p, o, logos });
      if (r) {
        bericht = { name: `dokumente/therapiebericht/Therapiebericht_${kurz}.pdf`, datum: r.reportDate };
        files.push({ name: bericht.name, bytes: Buffer.from(r.bytes) });
        berichte++;
      }
    } else if (vo.therapyReportRequested || vo.positions.some((x) => (toZlHpnr(x.position) ?? x.position) === THERAPY_REPORT_HPNR)) {
      fehlend.push(`Therapiebericht zu Verordnung ${vo.id.slice(0, 8)}: angefordert bzw. verordnet, aber nicht erstellt`);
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
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { bytes, count: vos.length, missing: fehlend.length };
}

export class HandoverIntegrityError extends Error {}

export type HandoverDownload = { bytes: Buffer; filename: string; sha256: string; reprint: boolean; afterFirstHandover: boolean; archivedAt: Date; missingDocuments: number };
export type HandoverStream = Omit<HandoverDownload, "bytes"> & { body: Buffer | Readable; sizeBytes: number };

const ARCHIVE_BROKEN = "Das archivierte Übergabepaket ist nicht lesbar oder beschädigt – bitte den Support kontaktieren (es wird bewusst nicht neu erzeugt).";

function checkKey(org: string, key: string) {
  if (!key.startsWith(`${org}/`) || key.includes("..")) throw new HandoverIntegrityError("Speicherschlüssel gehört nicht zur Praxis.");
}

/** Archivierte Datei lesen und gegen die gespeicherte Prüfsumme prüfen (nie stillschweigend neu erzeugen); auch für den Praxis-Export */
export async function readArchive(org: string, a: { storageKey: string; sha256: string }): Promise<Buffer> {
  checkKey(org, a.storageKey);
  const bytes = await readDecrypted(a.storageKey);
  if (sha256Hex(bytes) !== a.sha256) throw new HandoverIntegrityError("Prüfsumme des archivierten Übergabepakets stimmt nicht.");
  return bytes;
}

/** Rückmeldungsdatei (Beleg einer eingelesenen Auszahlung) lesen und gegen die Prüfsumme prüfen – Praxis-Export */
export async function readPayoutFile(org: string, a: { storageKey: string; sha256: string }): Promise<Buffer> {
  checkKey(org, a.storageKey);
  const bytes = await readDecrypted(a.storageKey);
  if (sha256Hex(bytes) !== a.sha256) throw new HandoverIntegrityError("Prüfsumme der Rückmeldungsdatei stimmt nicht.");
  return bytes;
}

/**
 * Archivierte Datei als Stream (Nachdruck ohne die ganze Datei im Speicher, AppSec H1): entschlüsselt blockweise, SHA-256
 * läuft mit. Der jeweils letzte Block wird zurückgehalten (Code-Review W1) und erst ausgegeben, wenn GCM-Tag
 * (decryptChunks) und Prüfsumme stimmen – sonst fehlen dem Empfänger Bytes (Content-Length) und der Download scheitert,
 * statt eine veränderte Datei vollständig auszuliefern.
 */
export function streamArchive(org: string, a: { storageKey: string; sha256: string }): Readable {
  checkKey(org, a.storageKey);
  const hash = createHash("sha256");
  let held: Buffer | null = null;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      const out = held;
      held = chunk;
      cb(null, out ?? undefined);
    },
    flush(cb) {
      if (hash.digest("hex") !== a.sha256) return cb(new HandoverIntegrityError("Prüfsumme des archivierten Übergabepakets stimmt nicht."));
      if (held) this.push(held);
      cb();
    },
  });
  // pipeline statt pipe: Fehler der Quelle (GCM-Tag, Lesefehler) kommen am Ergebnis an, und jede Seite wird bei Fehler
  // oder Abbruch der anderen zerstört (Client bricht ab → Entschlüsselung endet). Der Fehler erreicht den Aufrufer über
  // den zurückgegebenen Stream; der Callback verhindert nur eine unbehandelte Ablehnung.
  return pipeline(readDecryptedStream(a.storageKey), check, () => undefined);
}

type ArchiveRow = typeof billingBatchExports.$inferSelect;

/** höchstens so viele Erst-Exporte (Paketbau) gleichzeitig im Prozess (AppSec M1) – sonst „bitte später“ (429) */
export const MAX_PARALLEL_BUILDS = 2;
let buildsRunning = 0;

export type HandoverError = { error: string; busy?: true; notArchived?: true };
const NOT_ARCHIVED: HandoverError = { error: "Das Übergabepaket ist noch nicht erzeugt – bitte auf der Laufseite „Übergabepaket erzeugen“ wählen.", notArchived: true };

/**
 * Erster Abruf: erzeugen, Lauf als übergeben vermerken (zuerst – der Trigger verlangt einen übergebenen Lauf, AppSec H3),
 * verschlüsselt archivieren (eine Transaktion, Zeilensperre auf dem Lauf). Sonst: vorhandenes Archiv. null = nicht gefunden.
 */
async function ensureArchive(
  auth: AuthContext,
  batchId: string,
  format: "zip" | "csv",
  create: boolean,
): Promise<{ archive: ArchiveRow; bytes: Buffer | null; batch: { id: string; createdAt: Date } } | HandoverError | null> {
  const org = auth.organization.id;
  let written: string | null = null;
  try {
    return await withOrg(org, async (tx) => {
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
      if (!create) return NOT_ARCHIVED;
      // Zähler umfasst den ganzen Erstbau – Laden, Bauen, Verschlüsseln und Ablegen (Speicher-Spitze), nicht nur buildPackage
      if (buildsRunning >= MAX_PARALLEL_BUILDS) return { error: "Gerade werden schon Übergabepakete erzeugt – bitte in einer Minute erneut versuchen.", busy: true };
      buildsRunning++;
      let built: BuiltPackage;
      let stored: Awaited<ReturnType<typeof storeEncrypted>>;
      try {
        const data = await loadBatchExport(tx, org, batchId);
        if (!data) return null;
        const limit = paketGrenze(data.rows.length);
        if (limit) return { error: limit };
        built = await buildPackage(tx, org, data, new Date());
        if (built.bytes.length > HANDOVER_MAX_BYTES)
          return { error: `Das Übergabepaket wäre ${Math.round(built.bytes.length / 1_048_576)} MB groß (höchstens ${HANDOVER_MAX_BYTES / 1_048_576} MB) – bitte den Support kontaktieren.` };
        await markBatchExported(tx, org, batchId);
        stored = await storeEncrypted(org, built.bytes);
        written = stored.storageKey;
      } finally {
        buildsRunning--;
      }
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
          missingDocuments: built.missing,
          createdBy: auth.user.id,
        })
        .returning();
      await audit(
        {
          organizationId: org,
          userId: auth.user.id,
          action: "billing_batch.handover",
          entity: "billing_batch",
          entityId: batchId,
          meta: { reprint: false, format, count: built.count, missingDocuments: built.missing, sizeBytes: stored.sizeBytes, sha256: stored.sha256, afterFirstHandover: row.afterFirstHandover },
        },
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
}

const meta = (a: ArchiveRow, batch: { id: string; createdAt: Date }, reprint: boolean) => ({
  filename: `${baseName(batch)}${reprint ? "-Nachdruck" : ""}.zip`,
  sha256: a.sha256,
  reprint,
  afterFirstHandover: a.afterFirstHandover,
  archivedAt: a.createdAt,
  missingDocuments: a.missingDocuments,
});

const auditReprint = (auth: AuthContext, batchId: string, format: string, sha256: string) =>
  audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "billing_batch.handover", entity: "billing_batch", entityId: batchId, meta: { reprint: true, format, sha256 } });

/**
 * Übergabepaket eines Abrechnungslaufs als Bytes (archivierte Datei, byte-gleich, „Nachdruck“, gegen SHA-256 geprüft).
 * Der Erst-Export, der den Lauf unumkehrbar übergibt, nur mit ausdrücklichem `create: true` (Standard: nur Nachdruck,
 * sonst NOT_ARCHIVED). null = Lauf nicht gefunden.
 */
export async function handoverPackage(auth: AuthContext, batchId: string, opts: { format?: "zip" | "csv"; create?: boolean } = {}): Promise<HandoverDownload | HandoverError | null> {
  const blocked = access(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const res = await ensureArchive(auth, batchId, opts.format ?? "zip", opts.create ?? false);
  if (!res || "error" in res) return res;
  if (res.bytes) return { bytes: res.bytes, ...meta(res.archive, res.batch, false) };
  let bytes: Buffer;
  try {
    bytes = await readArchive(org, res.archive);
  } catch (e) {
    log.error("gkv_handover.archive_unreadable", { error: e, batchId });
    return { error: ARCHIVE_BROKEN };
  }
  await auditReprint(auth, batchId, opts.format ?? "zip", res.archive.sha256);
  return { bytes, ...meta(res.archive, res.batch, true) };
}

/**
 * Wie handoverPackage, der Nachdruck aber als Stream (Route). Ohne `create` nur Nachdruck (GET) – der Erst-Export, der den
 * Lauf unumkehrbar übergibt, nur mit `create` (POST mit Bestätigung, AppSec M2).
 */
export async function handoverPackageStream(auth: AuthContext, batchId: string, opts: { create?: boolean } = {}): Promise<HandoverStream | HandoverError | null> {
  const blocked = access(auth);
  if (blocked) return blocked;
  const res = await ensureArchive(auth, batchId, "zip", opts.create ?? false);
  if (!res || "error" in res) return res;
  if (res.bytes) return { body: res.bytes, sizeBytes: res.bytes.length, ...meta(res.archive, res.batch, false) };
  let body: Readable;
  try {
    body = streamArchive(auth.organization.id, res.archive);
  } catch (e) {
    log.error("gkv_handover.archive_unreadable", { error: e, batchId });
    return { error: ARCHIVE_BROKEN };
  }
  await auditReprint(auth, batchId, "zip", res.archive.sha256);
  return { body, sizeBytes: res.archive.sizeBytes, ...meta(res.archive, res.batch, true) };
}

async function discardIfUnreferenced(org: string, key: string) {
  try {
    const [ref] = await withOrg(org, (tx) => tx.select({ id: billingBatchExports.id }).from(billingBatchExports).where(and(eq(billingBatchExports.organizationId, org), eq(billingBatchExports.storageKey, key))));
    if (!ref) await discardStored(key);
  } catch (e) {
    log.warn("gkv_handover.cleanup_skipped", { error: e });
  }
}

/** verordnungen.csv aus dem archivierten Übergabepaket (nur mit ausdrücklichem `create: true` archiviert der erste Abruf das Paket; Standard und Route: nur Nachdruck) */
export async function handoverCsv(auth: AuthContext, batchId: string, opts: { create?: boolean } = {}): Promise<{ bytes: Buffer; filename: string; reprint: boolean } | HandoverError | null> {
  const pkg = await handoverPackage(auth, batchId, { format: "csv", create: opts.create ?? false });
  if (!pkg || "error" in pkg) return pkg;
  const zip = await JSZip.loadAsync(pkg.bytes);
  const f = zip.file("verordnungen.csv");
  if (!f) return { error: "Das Übergabepaket enthält keine verordnungen.csv." };
  return { bytes: Buffer.from(await f.async("uint8array")), filename: pkg.filename.replace(/^Uebergabe-/, "gkv-abrechnung-").replace(/\.zip$/, ".csv"), reprint: pkg.reprint };
}

export type PayoutRow = {
  id: string;
  amountCents: number;
  deductionCents: number;
  feeCents: number;
  paidAt: string;
  reference: string | null;
  source: string;
  lineCount: number;
  createdAt: Date;
  reversesPayoutId: string | null;
  reason: string | null;
  /** Storno dieser Auszahlung (falls storniert) */
  reversedBy: string | null;
};

/** Spalten einer Auszahlung für Übersichten */
const PAYOUT_COLS = {
  id: billingBatchPayouts.id,
  amountCents: billingBatchPayouts.amountCents,
  deductionCents: billingBatchPayouts.deductionCents,
  feeCents: billingBatchPayouts.feeCents,
  paidAt: billingBatchPayouts.paidAt,
  reference: billingBatchPayouts.reference,
  source: billingBatchPayouts.source,
  lineCount: billingBatchPayouts.lineCount,
  createdAt: billingBatchPayouts.createdAt,
  reversesPayoutId: billingBatchPayouts.reversesPayoutId,
  reason: billingBatchPayouts.reason,
};

async function payoutsOf(tx: Tx, org: string, batchId: string): Promise<PayoutRow[]> {
  const rows = await tx
    .select(PAYOUT_COLS)
    .from(billingBatchPayouts)
    .where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.billingBatchId, batchId)))
    .orderBy(asc(billingBatchPayouts.paidAt), asc(billingBatchPayouts.createdAt));
  const reversedBy = new Map(rows.filter((r) => r.reversesPayoutId).map((r) => [r.reversesPayoutId!, r.id]));
  return rows.map((r) => ({ ...r, reversedBy: reversedBy.get(r.id) ?? null }));
}

/**
 * Lauf mit Archiv, Auszahlungen (Stornos als Gegenbuchung mitgerechnet) und Absetzungen. „Noch offen“ = Kassenanteil laut
 * Lauf − Auszahlungen − Gebühren − Absetzungen, die den Kassenanteil mindern (aus gkv_deductions des Laufs: akzeptiert
 * bzw. erledigt/„bleibt“); offene/im Widerspruch stehende Absetzungen werden getrennt gezeigt. Hilfsrechnung, keine Buchung.
 */
export async function batchHandoverInfo(auth: AuthContext, batchId: string) {
  const blocked = access(auth);
  if (blocked) return null;
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [batch] = await tx.select().from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    if (!batch) return null;
    const [archive] = await tx
      .select({
        sha256: billingBatchExports.sha256,
        sizeBytes: billingBatchExports.sizeBytes,
        createdAt: billingBatchExports.createdAt,
        afterFirstHandover: billingBatchExports.afterFirstHandover,
        filename: billingBatchExports.filename,
        schemaVersion: billingBatchExports.schemaVersion,
        missingDocuments: billingBatchExports.missingDocuments,
      })
      .from(billingBatchExports)
      .where(and(eq(billingBatchExports.organizationId, org), eq(billingBatchExports.billingBatchId, batchId), eq(billingBatchExports.kind, HANDOVER_KIND)));
    const payouts = await payoutsOf(tx, org, batchId);
    // Absetzungen des Laufs je Absetzung genau einmal, nach Status (nicht je Rückmeldung summiert)
    const ded = await tx
      .select({ status: gkvDeductions.status, outcome: gkvDeductions.outcome, amountCents: gkvDeductions.amountCents, payoutId: gkvDeductions.payoutId })
      .from(gkvDeductions)
      .where(and(eq(gkvDeductions.organizationId, org), eq(gkvDeductions.billingBatchId, batchId)));
    const deductions = { reductionCents: 0, pendingCents: 0, reversedCents: 0 };
    for (const d of ded) {
      if (d.status === "accepted" || (d.status === "done" && d.outcome !== "reversed")) deductions.reductionCents += d.amountCents;
      else if (d.status === "done") deductions.reversedCents += d.amountCents;
      else deductions.pendingCents += d.amountCents;
    }
    const reversed = new Set(payouts.filter((p) => p.reversedBy).map((p) => p.id));
    const copay = batch.copaymentTotalCents ?? batch.totalCents;
    const sollInsurerCents = batch.remedyTotalCents === null ? null : batch.remedyTotalCents - copay;
    const paidCents = payouts.reduce((s, p) => s + p.amountCents, 0);
    const feeCents = payouts.reduce((s, p) => s + p.feeCents, 0);
    return {
      batch,
      archive: archive ?? null,
      payouts,
      sollInsurerCents,
      /** netto ausgezahlt (nach Gebühren, Stornos mitgerechnet) */
      paidCents,
      feeCents,
      deductions,
      openCents: sollInsurerCents === null ? null : sollInsurerCents - paidCents - feeCents - deductions.reductionCents,
      /** Absetzungen aus stornierten Rückmeldungen (bitte prüfen – werden nicht automatisch geändert) */
      reversedDeductionHints: ded.filter((d) => d.payoutId && reversed.has(d.payoutId)).length,
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
  gebuehrCent: number;
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
  summeGebuehrCent: number;
  /** diese Datei ist für diesen Lauf schon eingelesen (und nicht storniert) */
  bereitsEingelesen: boolean;
  /** inhaltlich gleiche Auszahlung (Datum, Referenz, Betrag) schon erfasst – nur mit Bestätigung übernehmen */
  duplikat: string | null;
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
    summeGebuehrCent: 0,
    bereitsEingelesen: false,
    duplikat: null,
  };
  const active = (await payoutsOf(tx, org, batchId)).filter((p) => p.source !== "reversal" && !p.reversedBy);
  const shas = active.length
    ? await tx
        .select({ id: billingBatchPayouts.id })
        .from(billingBatchPayouts)
        .where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.billingBatchId, batchId), eq(billingBatchPayouts.sourceSha256, parsed.sha256)))
    : [];
  preview.bereitsEingelesen = shas.some((r) => active.some((a) => a.id === r.id));
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
    const gedeckt = z.ausgezahltCent + z.gebuehrCent + (z.absetzung?.betragCent ?? 0);
    if (soll !== null && gedeckt !== soll)
      hinweise.push(`Ausgezahlt + Gebühr + Absetzung weicht vom Kassenanteil laut Lauf ab (${((gedeckt - soll) / 100).toFixed(2).replace(".", ",")} €)`);
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
      gebuehrCent: z.gebuehrCent,
      absetzung: z.absetzung,
      absetzungVorhanden,
      hinweise,
    });
    preview.summeAusgezahltCent += z.ausgezahltCent;
    preview.summeAbsetzungCent += z.absetzung?.betragCent ?? 0;
    preview.summeGebuehrCent += z.gebuehrCent;
  }
  if (!preview.fehler.length && !preview.zeilen.length) preview.fehler.push("Keine Zeile gehört zu diesem Abrechnungslauf.");
  // Grenzen wie in der Datenbank (CHECK) – verständliche Meldung statt Datenbankfehler (Code-Review K2)
  if (preview.summeAusgezahltCent > 100_000_000 || preview.summeAbsetzungCent > 100_000_000 || preview.summeGebuehrCent > 100_000_000) preview.fehler.push("Summe über 1 Mio. € – bitte prüfen.");
  if (preview.fehler.length) preview.zeilen = [];
  else preview.duplikat = duplicateOf(active, { paidAt: preview.auszahlungsdatum, reference: preview.sammelrechnungsnummer, amountCents: preview.summeAusgezahltCent });
  return preview;
}

/** Referenz vergleichbar machen: nur Buchstaben/Ziffern, klein („SR-9“ = „sr 9“) */
const refKey = (r: string | null | undefined) => (r ?? "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");

/**
 * Inhaltlich gleiche, nicht stornierte Auszahlung (Lauf, Auszahlungsdatum, Referenz, Betrag) – unabhängig davon, ob von
 * Hand oder eingelesen und ob die Datei bytegleich ist (CRLF, JSON statt CSV). Warnung, keine Sperre.
 */
function duplicateOf(active: PayoutRow[], k: { paidAt: string | null; reference: string | null; amountCents: number }): string | null {
  const hit = active.find((a) => a.paidAt === k.paidAt && refKey(a.reference) === refKey(k.reference) && a.amountCents === k.amountCents);
  return hit
    ? `Eine gleiche Auszahlung ist bereits erfasst (${hit.paidAt.split("-").reverse().join(".")}, ${hit.reference ?? "ohne Referenz"}, ${(hit.amountCents / 100).toFixed(2).replace(".", ",")} €, ${hit.source === "import" ? "Rückmeldung" : "von Hand"}) – mögliche Doppelerfassung.`
    : null;
}

const DUPLICATE_ERROR = "Mögliche Doppelerfassung: Eine gleiche Auszahlung (Datum, Referenz, Betrag) ist bereits erfasst – bitte prüfen und ausdrücklich bestätigen.";

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

/** 23505 nur dann als „bereits eingelesen“ melden, wenn er vom Index bzw. Trigger der Datei-Prüfsumme kommt (Code-Review D) */
function isSourceDuplicate(e: unknown): boolean {
  const x = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = x?.cause?.code ?? x?.code;
  const constraint = x?.cause?.constraint ?? x?.constraint;
  return code === "23505" && constraint === "billing_batch_payouts_source";
}

/**
 * Rückmeldung übernehmen – nur mit derselben Datei wie in der Vorschau (Prüfsumme) und ohne Fehler: die Datei wird als Beleg
 * verschlüsselt abgelegt, dazu eine Auszahlung (Summe der Zeilen dieses Laufs, Gebühr) und neue Absetzungen (Status
 * „offen“, Kassenschreiben = Sammelrechnungsnummer). Bereits erfasste gleiche Absetzungen werden übersprungen.
 * Inhaltlich gleiche Auszahlung (Datum, Referenz, Betrag) nur mit `confirmDuplicate`. Verordnungen bleiben unverändert.
 */
export async function confirmPayoutImport(
  auth: AuthContext,
  batchId: string,
  bytes: Uint8Array,
  dateiname: string,
  expectedSha256: string,
  opts: { confirmDuplicate?: boolean } = {},
): Promise<{ payoutId: string; deductions: number; skippedDeductions: number } | { error: string }> {
  const blocked = access(auth);
  if (blocked) return blocked;
  if (auth.support) return { error: SUPPORT_DENIED };
  const org = auth.organization.id;
  if (sha256Hex(bytes) !== expectedSha256) return { error: "Die Datei wurde seit der Vorschau geändert – bitte erneut prüfen." };
  const name = dateiname.slice(0, MAX_NAME);
  let written: string | null = null;
  try {
    return await withOrg(org, async (tx) => {
      // je Lauf nacheinander (gleichzeitiges Einlesen derselben Datei scheitert zusätzlich am eindeutigen Index)
      const [locked] = await tx.select({ id: billingBatches.id }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId))).for("update");
      if (!locked) return { error: "Abrechnungslauf nicht gefunden." };
      const p = await matchRueckmeldung(tx, org, batchId, bytes, name);
      if ("error" in p) return p;
      if (p.bereitsEingelesen) return { error: "Diese Rückmeldung ist für diesen Abrechnungslauf bereits eingelesen." };
      if (p.fehler.length || !p.zeilen.length || !p.auszahlungsdatum) return { error: `Die Rückmeldung enthält Fehler – bitte die Vorschau prüfen.${p.fehler.length ? ` (${p.fehler[0]})` : ""}` };
      if (p.duplikat && !opts.confirmDuplicate) return { error: DUPLICATE_ERROR };
      // Datei als Beleg (verschlüsselt) – vor dem Eintrag; scheitert der Vorgang, wird sie unten wieder entfernt
      const stored = await storeEncrypted(org, Buffer.from(bytes));
      written = stored.storageKey;
      const [payout] = await tx
        .insert(billingBatchPayouts)
        .values({
          organizationId: org,
          billingBatchId: batchId,
          amountCents: p.summeAusgezahltCent,
          deductionCents: p.summeAbsetzungCent,
          feeCents: p.summeGebuehrCent,
          paidAt: p.auszahlungsdatum,
          reference: p.sammelrechnungsnummer,
          source: "import",
          sourceSha256: p.sha256,
          storageKey: stored.storageKey,
          sourceFilename: cleanText(name, 200) || "rueckmeldung",
          lineCount: p.zeilen.length,
          details: p.zeilen.map((z) => ({ prescriptionId: z.prescriptionId, paidCents: z.ausgezahltCent, deductionCents: z.absetzung?.betragCent ?? 0, feeCents: z.gebuehrCent })),
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
          meta: {
            payoutId: payout.id,
            lines: p.zeilen.length,
            amountCents: p.summeAusgezahltCent,
            deductionCents: p.summeAbsetzungCent,
            feeCents: p.summeGebuehrCent,
            deductions: neu.length,
            skippedDeductions: skipped,
            otherBatch: p.andererLauf,
            sha256: p.sha256,
            duplicateConfirmed: !!p.duplikat,
          },
        },
        tx,
      );
      return { payoutId: payout.id, deductions: neu.length, skippedDeductions: skipped };
    });
  } catch (e) {
    if (isSourceDuplicate(e)) return { error: "Diese Rückmeldung ist für diesen Abrechnungslauf bereits eingelesen." };
    throw e;
  } finally {
    // Antwort mit Fehler (kein Eintrag, z. B. Validierung nach dem Ablegen) → Datei entfernen
    if (written) await discardPayoutFileIfUnreferenced(org, written);
  }
}

async function discardPayoutFileIfUnreferenced(org: string, key: string) {
  try {
    const [ref] = await withOrg(org, (tx) => tx.select({ id: billingBatchPayouts.id }).from(billingBatchPayouts).where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.storageKey, key))));
    if (!ref) await discardStored(key);
  } catch (e) {
    log.warn("gkv_handover.cleanup_skipped", { error: e });
  }
}

export const manualPayoutInput = z.object({
  batchId: z.string().uuid(),
  amountCents: z.coerce.number().int("Betrag ungültig.").min(1, "Betrag muss größer als 0 sein.").max(AUSZAHLUNG_MAX_CENT * 10, "Betrag über 1 Mio. € – bitte prüfen."),
  /** einbehaltene Gebühr des Abrechnungszentrums (optional) */
  feeCents: z.coerce.number().int("Gebühr ungültig.").min(0, "Gebühr darf nicht negativ sein.").max(AUSZAHLUNG_MAX_CENT * 10, "Gebühr über 1 Mio. € – bitte prüfen.").optional(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum der Auszahlung ungültig."),
  reference: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 80) || null : v ?? null), z.string().max(60, "Referenz: höchstens 60 Zeichen.").nullable()),
  /** inhaltlich gleiche Auszahlung trotzdem erfassen (Häkchen) */
  confirmDuplicate: z.boolean().optional(),
});
export type ManualPayoutInput = z.input<typeof manualPayoutInput>;

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
  return withOrg(org, async (tx) => {
    const [b] = await tx.select({ exportedAt: billingBatches.exportedAt }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, d.batchId))).for("update");
    if (!b) return { error: "Abrechnungslauf nicht gefunden." };
    if (!b.exportedAt) return { error: "Auszahlungen gibt es nur zu übergebenen Abrechnungsläufen." };
    const active = (await payoutsOf(tx, org, d.batchId)).filter((p) => p.source !== "reversal" && !p.reversedBy);
    const dup = duplicateOf(active, { paidAt: d.paidAt, reference: d.reference, amountCents: d.amountCents });
    if (dup && !d.confirmDuplicate) return { error: DUPLICATE_ERROR };
    const [row] = await tx
      .insert(billingBatchPayouts)
      .values({ organizationId: org, billingBatchId: d.batchId, amountCents: d.amountCents, feeCents: d.feeCents ?? 0, paidAt: d.paidAt, reference: d.reference, source: "manual", createdBy: auth.user.id })
      .returning({ id: billingBatchPayouts.id });
    await audit(
      { organizationId: org, userId: auth.user.id, action: "billing_batch.payout_manual", entity: "billing_batch", entityId: d.batchId, meta: { payoutId: row.id, amountCents: d.amountCents, feeCents: d.feeCents ?? 0, paidAt: d.paidAt, duplicateConfirmed: !!dup } },
      tx,
    );
    return { id: row.id };
  });
}

export const reversePayoutInput = z.object({
  payoutId: z.string().uuid(),
  reason: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 600) : v), z.string().min(5, "Bitte eine Begründung angeben (mindestens 5 Zeichen).").max(500, "Begründung: höchstens 500 Zeichen.")),
});

/**
 * Storno einer Auszahlung (Fehleingabe, falsche Rückmeldung): Gegenbuchung mit exakt negativen Beträgen am heutigen Tag
 * (wirkt in der Auswertung im Monat des Stornos, nicht rückwirkend). Höchstens ein Storno je Auszahlung, ein Storno ist nicht
 * stornierbar (Trigger + eindeutiger Index). Verknüpfte Absetzungen bleiben unverändert (Hinweis auf der Laufseite); eine
 * stornierte Rückmeldungsdatei kann erneut eingelesen werden.
 */
export async function reversePayout(auth: AuthContext, input: z.input<typeof reversePayoutInput>): Promise<{ id: string } | { error: string }> {
  const blocked = access(auth);
  if (blocked) return blocked;
  if (auth.support) return { error: SUPPORT_DENIED };
  const parsed = reversePayoutInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingabe ungültig." };
  const org = auth.organization.id;
  try {
    return await withOrg(org, async (tx) => {
      const [o] = await tx.select().from(billingBatchPayouts).where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.id, parsed.data.payoutId)));
      if (!o) return { error: "Auszahlung nicht gefunden." };
      // Lauf sperren: Stornos und Importe desselben Laufs nacheinander
      await tx.select({ id: billingBatches.id }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, o.billingBatchId))).for("update");
      if (o.source === "reversal") return { error: "Ein Storno kann nicht storniert werden." };
      const [already] = await tx.select({ id: billingBatchPayouts.id }).from(billingBatchPayouts).where(and(eq(billingBatchPayouts.organizationId, org), eq(billingBatchPayouts.reversesPayoutId, o.id)));
      if (already) return { error: "Diese Auszahlung ist bereits storniert." };
      const [row] = await tx
        .insert(billingBatchPayouts)
        .values({
          organizationId: org,
          billingBatchId: o.billingBatchId,
          amountCents: -o.amountCents,
          deductionCents: -o.deductionCents,
          feeCents: -o.feeCents,
          paidAt: berlinDateIso(),
          reference: o.reference,
          source: "reversal",
          reversesPayoutId: o.id,
          reason: parsed.data.reason,
          createdBy: auth.user.id,
        })
        .returning({ id: billingBatchPayouts.id });
      const linked = await tx.select({ id: gkvDeductions.id }).from(gkvDeductions).where(and(eq(gkvDeductions.organizationId, org), eq(gkvDeductions.payoutId, o.id)));
      // Audit ohne Begründung (Freitext)
      await audit(
        { organizationId: org, userId: auth.user.id, action: "billing_batch.payout_reversal", entity: "billing_batch", entityId: o.billingBatchId, meta: { payoutId: o.id, reversalId: row.id, amountCents: -o.amountCents, linkedDeductions: linked.length } },
        tx,
      );
      return { id: row.id };
    });
  } catch (e) {
    const x = e as { code?: string; cause?: { code?: string } };
    if ((x?.cause?.code ?? x?.code) === "23505") return { error: "Diese Auszahlung ist bereits storniert." };
    throw e;
  }
}

/** Auszahlungen je Lauf (Übersicht) – Summe netto inkl. Stornos und letzte Auszahlung; Rechte wie die Abrechnung (AppSec H5) */
export async function payoutTotals(auth: AuthContext): Promise<Map<string, { cents: number; count: number; last: string | null }>> {
  const out = new Map<string, { cents: number; count: number; last: string | null }>();
  if (access(auth)) return out;
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) =>
    tx
      .select({
        id: billingBatchPayouts.id,
        batchId: billingBatchPayouts.billingBatchId,
        amountCents: billingBatchPayouts.amountCents,
        paidAt: billingBatchPayouts.paidAt,
        source: billingBatchPayouts.source,
        reversesPayoutId: billingBatchPayouts.reversesPayoutId,
      })
      .from(billingBatchPayouts)
      .where(eq(billingBatchPayouts.organizationId, org))
      .orderBy(desc(billingBatchPayouts.paidAt)),
  );
  // stornierte Auszahlungen und Stornos zählen nicht als Auszahlung (Betrag: Gegenbuchung hebt sich auf, Code-Review K3)
  const reversed = new Set(rows.map((r) => r.reversesPayoutId).filter(Boolean));
  for (const r of rows) {
    const cur = out.get(r.batchId) ?? { cents: 0, count: 0, last: null };
    cur.cents += r.amountCents;
    if (r.source !== "reversal" && !reversed.has(r.id)) {
      cur.count++;
      cur.last ??= r.paidAt;
    }
    out.set(r.batchId, cur);
  }
  return out;
}
