/**
 * Schreibt ein geprüftes ImportResult (parseWorkbook) in die Datenbank.
 *
 * Aufruf innerhalb von withOrg(organizationId, (tx) => persistImport(tx, organizationId, result, userId)),
 * damit RLS greift und alles in EINER Transaktion passiert (bei Fehler: kompletter Rollback).
 *
 * Regeln:
 *  - Patienten: Patientennummer = Legacy-ID aus Excel; bei Kollision (bestehend/doppelt) nächste freie Nummer.
 *  - Leistungen: Upsert über (organization_id, code).
 *  - Gutscheine: neu anlegen; vorhandene Nummern werden nicht überschrieben.
 *  - Rechnungen: mit Legacy-Nummer als „issued“/„partially_paid“/„paid“. Weil der DB-Trigger
 *    invoice_lines_guard Positionen nur bei Entwürfen erlaubt, wird jede Rechnung erst als „draft“
 *    angelegt, dann werden die Positionen eingefügt, danach wird der Status gesetzt.
 *  - Vorhandene Rechnungsnummern werden übersprungen (GoBD: ausgestellte Rechnungen unveränderbar).
 *  - Sammelrechnungs-Teile werden als Positionen in die SR übernommen (keine eigenen Rechnungen),
 *    daher bleibt `collective_invoice_id` beim Import leer.
 *  - Nummernkreise werden hinter die höchste Altnummer im CRM-Format gesetzt (ensureSequenceAtLeast).
 */
import { assertPatientCapacity } from "@/server/patient-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import * as s from "@/db/schema";
import { ensureSequenceAtLeast } from "@/lib/numbering";
import type { ImportResult, ImportWarning, PatientImportDraft } from "./types";

export interface PersistSummary {
  patients: number;
  services: number;
  vouchers: number;
  fixedCosts: number;
  invoices: number;
  invoiceLines: number;
  payments: number;
  /** Legacy-Patienten-ID → neue Patienten-UUID */
  patientIdByLegacyId: Record<number, string>;
  /** Legacy-ID → vergebene Patientennummer (falls abweichend) */
  renumberedPatients: { legacyId: number | null; number: number }[];
  /** angepasste Nummernkreise (nächste freie Nummer) */
  sequences: { key: string; year: number; next: number }[];
  warnings: ImportWarning[];
}

const CHUNK = 500;
function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const SOURCE = "excel-import:rechnungsmanager-0.9.2";

function patientNotes(p: PatientImportDraft): string | null {
  const parts: string[] = [];
  if (p.notes) parts.push(p.notes);
  if (p.legacy.status) parts.push(`Status (Altdaten): ${p.legacy.status}`);
  return parts.length ? parts.join("\n") : null;
}

const isInactive = (status: string | null) => !!status && /(inaktiv|archiv|verstorben|gelöscht)/i.test(status);

export async function persistImport(tx: Tx, organizationId: string, result: ImportResult, userId: string): Promise<PersistSummary> {
  const warnings: ImportWarning[] = [];
  const summary: PersistSummary = {
    patients: 0,
    services: 0,
    vouchers: 0,
    fixedCosts: 0,
    invoices: 0,
    invoiceLines: 0,
    payments: 0,
    patientIdByLegacyId: {},
    renumberedPatients: [],
    sequences: [],
    warnings,
  };

  // ───── Patienten ─────
  // Patientennummern konkurrenzsicher vergeben (gleicher Lock wie Doctolib-Import)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + organizationId}))`);
  // Tarif-Grenze (Kostenlos: 20 Patient:innen) – auch archiviert importierte zählen mit
  await assertPatientCapacity(tx, organizationId, result.patients.length);
  const existingNumbers = new Set(
    (await tx.select({ number: s.patients.number }).from(s.patients).where(eq(s.patients.organizationId, organizationId))).map((r) => r.number),
  );
  const used = new Set(existingNumbers);
  let next = Math.max(0, ...existingNumbers, ...result.patients.map((p) => p.legacyId ?? 0)) + 1;
  const numbered = result.patients.map((p) => {
    let number: number;
    if (p.legacyId !== null && p.legacyId > 0 && !used.has(p.legacyId)) number = p.legacyId;
    else {
      number = next++;
      summary.renumberedPatients.push({ legacyId: p.legacyId, number });
    }
    used.add(number);
    return { draft: p, number };
  });
  const patientIdByNumber = new Map<number, string>();
  for (const part of chunks(numbered)) {
    const rows = await tx
      .insert(s.patients)
      .values(
        part.map(({ draft: p, number }) => ({
          organizationId,
          number,
          salutation: p.salutation,
          title: p.title,
          lastName: p.lastName,
          firstName: p.firstName,
          birthDate: p.birthDate,
          street: p.street,
          zip: p.zip,
          city: p.city,
          phoneMobile: p.phoneMobile,
          phoneLandline: p.phoneLandline,
          email: p.email,
          preferredChannel: p.preferredChannel,
          notes: patientNotes(p),
          route: p.route,
          homeVisit: !!p.route,
          externalIds: p.legacyId !== null ? { legacyExcel: p.legacyId } : {},
          extra: { legacyExcel: p.legacy },
          source: SOURCE,
          archivedAt: isInactive(p.legacy.status) ? new Date() : null,
        })),
      )
      .returning({ id: s.patients.id, number: s.patients.number });
    for (const r of rows) patientIdByNumber.set(r.number, r.id);
    summary.patients += rows.length;
  }
  for (const { draft, number } of numbered) {
    const id = patientIdByNumber.get(number);
    if (id && draft.legacyId !== null && summary.patientIdByLegacyId[draft.legacyId] === undefined) {
      summary.patientIdByLegacyId[draft.legacyId] = id;
    }
  }

  // ───── Leistungen (Upsert über Code) ─────
  // Nur aktive Leistungen: eine archivierte (Kürzel noch ohne „_archiv“-Zusatz, Altbestand) wird weder geändert noch
  // zugeordnet – die Positionen behalten Bezeichnung/Preis als Kopie, ohne Verweis.
  const serviceIdByCode = new Map<string, string>();
  for (const part of chunks(result.services)) {
    const rows = await tx
      .insert(s.services)
      .values(
        part.map((sv) => ({
          organizationId,
          code: sv.code,
          name: sv.name,
          priceCents: sv.priceCents,
          vatRate: sv.vatRate,
          durationMin: sv.durationMin,
          requiresTherapeuticPurpose: sv.vatRate === 0,
        })),
      )
      .onConflictDoUpdate({
        target: [s.services.organizationId, s.services.code],
        set: {
          name: sql`excluded.name`,
          priceCents: sql`excluded.price_cents`,
          vatRate: sql`excluded.vat_rate`,
          durationMin: sql`excluded.duration_min`,
        },
        setWhere: eq(s.services.active, true),
      })
      .returning({ id: s.services.id, code: s.services.code });
    for (const r of rows) serviceIdByCode.set(r.code.toUpperCase(), r.id);
    summary.services += rows.length;
  }
  // in Rechnungen verwendete, aber nicht im Blatt enthaltene Codes aus der DB nachschlagen
  const missingCodes = [...new Set(result.invoices.flatMap((i) => i.lines.map((l) => l.serviceCode)))].filter((c) => !serviceIdByCode.has(c.toUpperCase()));
  if (missingCodes.length) {
    const rows = await tx
      .select({ id: s.services.id, code: s.services.code })
      .from(s.services)
      .where(and(eq(s.services.organizationId, organizationId), eq(s.services.active, true), inArray(s.services.code, missingCodes)));
    for (const r of rows) serviceIdByCode.set(r.code.toUpperCase(), r.id);
  }

  // ───── Gutscheine ─────
  const voucherIdByLegacy = new Map<number, string>();
  const voucherIdByCode = new Map<string, string>();
  if (result.vouchers.length) {
    const existing = await tx
      .select({ id: s.vouchers.id, code: s.vouchers.code })
      .from(s.vouchers)
      .where(and(eq(s.vouchers.organizationId, organizationId), inArray(s.vouchers.code, result.vouchers.map((v) => v.code))));
    for (const e of existing) voucherIdByCode.set(e.code, e.id);
    const fresh = result.vouchers.filter((v) => {
      if (voucherIdByCode.has(v.code)) {
        warnings.push({ sheet: "Gutscheine", row: v.row, message: `Gutschein „${v.code}“ existiert bereits – nicht überschrieben.` });
        return false;
      }
      return true;
    });
    for (const part of chunks(fresh)) {
      const rows = await tx
        .insert(s.vouchers)
        .values(
          part.map((v) => ({
            organizationId,
            code: v.code,
            issuedAt: v.issuedAt,
            validUntil: v.validUntil,
            amountCents: v.amountCents,
            // bereits in der Altzeit eingelöst = Betrag − Restbetrag
            openingRedeemedCents: v.remainingCents === null ? 0 : Math.min(v.amountCents, Math.max(0, v.amountCents - v.remainingCents)),
            note: v.note,
          })),
        )
        .returning({ id: s.vouchers.id, code: s.vouchers.code });
      for (const r of rows) voucherIdByCode.set(r.code, r.id);
      summary.vouchers += rows.length;
    }
    for (const v of result.vouchers) {
      const id = voucherIdByCode.get(v.code);
      if (id && v.legacyId !== null) voucherIdByLegacy.set(v.legacyId, id);
    }
  }

  // ───── Fixkosten ─────
  for (const part of chunks(result.fixedCosts)) {
    if (!part.length) continue;
    await tx.insert(s.fixedCosts).values(
      part.map((f) => ({ organizationId, category: f.category, amountCents: f.amountCents, interval: f.interval, startDate: f.startDate, note: "Import aus Excel (Kalkulation)" })),
    );
    summary.fixedCosts += part.length;
  }

  // ───── Rechnungen ─────
  if (result.invoices.length) {
    const existingNumbers = new Set(
      (
        await tx
          .select({ number: s.invoices.number })
          .from(s.invoices)
          .where(and(eq(s.invoices.organizationId, organizationId), inArray(s.invoices.number, result.invoices.map((i) => i.number))))
      ).map((r) => r.number),
    );
    const toInsert = result.invoices.filter((inv) => {
      if (existingNumbers.has(inv.number)) {
        warnings.push({ sheet: "Rechnungen", row: inv.row, message: `Rechnungsnummer „${inv.number}“ existiert bereits – übersprungen.` });
        return false;
      }
      return true;
    });

    for (const part of chunks(toInsert, 200)) {
      // 1) als Entwurf OHNE Nummer anlegen (eine vergebene Nummer gilt als ausgestellt → Positionen wären gesperrt)
      const created: { id: string; number: string | null }[] = [];
      for (const inv of part) {
        const [row] = await tx
        .insert(s.invoices)
        .values(
          [inv].map((inv) => {
            const patientId = inv.patientLegacyId !== null ? summary.patientIdByLegacyId[inv.patientLegacyId] ?? null : null;
            if (inv.patientLegacyId !== null && !patientId) {
              warnings.push({ sheet: "Rechnungen", row: inv.row, message: `Patient ${inv.patientLegacyId} nicht gefunden – Rechnung ohne Patientenbezug.` });
            }
            return {
              organizationId,
              patientId,
              number: null,
              kind: inv.kind,
              status: "draft" as const,
              issuedAt: inv.issuedAt,
              netCents: inv.netCents,
              vatCents: inv.vatCents,
              totalCents: inv.totalCents,
              paidCents: 0,
              source: "excel-import",
              notes: [
                `Import aus Excel (Zeile ${inv.row}${inv.legacyId !== null ? `, ID ${inv.legacyId}` : ""})`,
                inv.paymentRaw ? `Bezahlung: ${inv.paymentRaw}` : null,
                inv.collectedLegacyIds.length ? `Sammelrechnung aus Zeilen-IDs ${inv.collectedLegacyIds.join(", ")}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
              createdBy: userId,
            };
          }),
        )
        .returning({ id: s.invoices.id });
        created.push({ id: row.id, number: inv.number });
      }
      const idByNumber = new Map(created.map((c) => [c.number, c.id]));
      summary.invoices += created.length;

      // 2) Positionen
      const lineRows = part.flatMap((inv) =>
        inv.lines.map((l) => ({
          organizationId,
          invoiceId: idByNumber.get(inv.number)!,
          serviceId: serviceIdByCode.get(l.serviceCode.toUpperCase()) ?? null,
          description: l.description,
          quantity: String(l.quantity),
          factor: String(l.factor),
          unitPriceCents: l.unitPriceCents,
          vatRate: l.vatRate,
          totalCents: l.totalCents,
          position: l.position,
        })),
      );
      for (const lp of chunks(lineRows)) {
        if (!lp.length) continue;
        await tx.insert(s.invoiceLines).values(lp);
        summary.invoiceLines += lp.length;
      }

      // 3) Status setzen, 4) Zahlungen
      const paymentRows: (typeof s.payments.$inferInsert)[] = [];
      for (const inv of part) {
        const invoiceId = idByNumber.get(inv.number)!;
        const paidCents = Math.min(inv.totalCents, inv.payments.reduce((a, p) => a + p.amountCents, 0));
        await tx.update(s.invoices).set({ number: inv.number, status: inv.status, paidCents }).where(and(eq(s.invoices.id, invoiceId), eq(s.invoices.organizationId, organizationId)));
        const paidAt = inv.issuedAt ? new Date(`${inv.issuedAt}T12:00:00Z`) : new Date();
        for (const p of inv.payments) {
          const voucherId = p.method === "voucher" && p.voucherLegacyId != null ? voucherIdByLegacy.get(p.voucherLegacyId) ?? null : null;
          if (p.method === "voucher" && !voucherId) {
            warnings.push({ sheet: "Rechnungen", row: inv.row, message: "Gutscheinzahlung ohne zuordenbaren Gutschein importiert." });
          }
          paymentRows.push({ organizationId, invoiceId, method: p.method, amountCents: p.amountCents, paidAt, voucherId, externalRef: `excel:${inv.number}`, createdBy: userId });
        }
      }
      for (const pp of chunks(paymentRows)) {
        if (!pp.length) continue;
        await tx.insert(s.payments).values(pp);
        summary.payments += pp.length;
      }
    }
  }

  // ───── Nummernkreise hinter die höchsten Altnummern setzen ─────
  summary.sequences = await bumpSequences(tx, organizationId, [
    ...result.invoices.flatMap((i) => [i.number, ...i.collectedNumbers]),
    ...result.vouchers.map((v) => v.code),
  ]);

  return summary;
}

/** CRM-Nummernformat (siehe src/lib/numbering.ts): R2026-0001, Q…, SR…, GS…, G… */
export const CRM_NUMBER_RE = /^(R|Q|SR|GS|G)(\d{4})-(\d+)$/;
const SEQUENCE_KEY: Record<string, string> = { R: "invoice", Q: "receipt", SR: "collective", GS: "credit_note", G: "voucher" };

/** Ermittelt je Nummernkreis/Jahr die höchste importierte Nummer → nächster freier Wert. */
export function sequenceMinimums(numbers: string[]): { key: string; year: number; next: number }[] {
  const max = new Map<string, number>();
  for (const n of numbers) {
    const m = n.trim().match(CRM_NUMBER_RE);
    if (!m) continue;
    const k = `${SEQUENCE_KEY[m[1]]}|${m[2]}`;
    max.set(k, Math.max(max.get(k) ?? 0, Number(m[3])));
  }
  return [...max.entries()].map(([k, n]) => {
    const [key, year] = k.split("|");
    return { key, year: Number(year), next: n + 1 };
  });
}

async function bumpSequences(tx: Tx, organizationId: string, numbers: string[]) {
  const mins = sequenceMinimums(numbers);
  for (const m of mins) await ensureSequenceAtLeast(tx, organizationId, m.key, m.year, m.next);
  return mins;
}
