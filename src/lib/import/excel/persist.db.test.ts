/** Echter Datenbanktest des Excel-Imports (nur mit TEST_DATABASE_URL; erfundene Daten). */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as s from "@/db/schema";
import { parseWorkbook } from "./parse";
import { FUTURE_PAYMENT_WARNING, persistImport } from "./persist";
import ExcelJS from "exceljs";
import { buildWorkbook } from "./excel-import.test";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Excel-Import gegen PostgreSQL (RLS, Trigger)", () => {
  it("importiert Patienten, Leistungen, Gutscheine, Rechnungen und Fixkosten", async () => {
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema: s });
    const [org] = await db.insert(s.organizations).values({ name: "Import-Test", slug: `imp-${Date.now()}` }).returning();
    const [user] = await db.insert(s.users).values({ email: `imp-${Date.now()}@example.org`, name: "T", passwordHash: "x" }).returning();
    await db.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    const parsed = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      await persistImport(tx as never, org.id, parsed, user.id);
    });
    const counts = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      const n = async (t: typeof s.patients | typeof s.services | typeof s.invoices | typeof s.vouchers | typeof s.fixedCosts) =>
        (await tx.select().from(t as typeof s.patients).where(eq((t as typeof s.patients).organizationId, org.id))).length;
      return { p: await n(s.patients), sv: await n(s.services), inv: await n(s.invoices), v: await n(s.vouchers), fc: await n(s.fixedCosts) };
    });
    expect(counts.p).toBe(parsed.patients.length);
    expect(counts.sv).toBeGreaterThan(0);
    expect(counts.inv).toBe(parsed.invoices.length);
    expect(counts.v).toBe(parsed.vouchers.length);
    expect(counts.fc).toBe(parsed.fixedCosts.length);
    await pool.end();
  });

  it("ordnet nur aktiven Leistungen zu – archivierte (Altbestand mit gleichem Kürzel) bleiben unverändert", async () => {
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema: s });
    const [org] = await db.insert(s.organizations).values({ name: "Import-Archiv", slug: `imp-arch-${Date.now()}` }).returning();
    const [user] = await db.insert(s.users).values({ email: `imp-arch-${Date.now()}@example.org`, name: "T", passwordHash: "x" }).returning();
    await db.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    const parsed = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const usedCodes = new Set(parsed.invoices.flatMap((i) => i.lines.map((l) => l.serviceCode)));
    const code = parsed.services.find((sv) => usedCodes.has(sv.code))?.code ?? parsed.services[0].code;
    const inOrg = <T,>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
        return fn(tx);
      });
    const [old] = await inOrg((tx) =>
      tx.insert(s.services).values({ organizationId: org.id, code, name: "Archiviert alt", priceCents: 1, active: false }).returning({ id: s.services.id }),
    );
    await inOrg((tx) => persistImport(tx as never, org.id, parsed, user.id));
    const after = await inOrg(async (tx) => ({
      svc: (await tx.select().from(s.services).where(eq(s.services.id, old.id)))[0],
      lines: await tx.select({ id: s.invoiceLines.id }).from(s.invoiceLines).where(eq(s.invoiceLines.serviceId, old.id)),
    }));
    expect(after.svc).toMatchObject({ name: "Archiviert alt", priceCents: 1, active: false });
    expect(after.lines).toEqual([]);
    await pool.end();
  });
  async function freshOrg(tag: string) {
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema: s });
    const [org] = await db.insert(s.organizations).values({ name: `Import-${tag}`, slug: `imp-${tag}-${Date.now()}` }).returning();
    const [user] = await db.insert(s.users).values({ email: `imp-${tag}-${Date.now()}@example.org`, name: "T", passwordHash: "x" }).returning();
    await db.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    const inOrg = <T,>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
        return fn(tx);
      });
    return { pool, org, user, inOrg };
  }

  it("Runde 4 R2: Rechnung zu Patient mit 8-stelliger Legacy-ID behält den Patientenbezug (nur die Nummer wird neu vergeben)", async () => {
    const { pool, org, user, inOrg } = await freshOrg("r2");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook()) as never);
    wb.getWorksheet("Patienten")!.getCell("A3").value = 12_345_678;
    const r = wb.getWorksheet("Rechnungen")!;
    for (const row of [4, 5, 6, 7]) r.getCell(`F${row}`).value = 12_345_678;
    const parsed = await parseWorkbook(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer), { today: "2026-11-07" });
    const sum = await inOrg((tx) => persistImport(tx as never, org.id, parsed, user.id));
    expect(sum.warnings.some((w) => /nicht gefunden/.test(w.message))).toBe(false);
    const res = await inOrg(async (tx) => {
      const [p] = await tx.select().from(s.patients).where(sql`${s.patients.organizationId} = ${org.id} and ${s.patients.lastName} = 'Mustermann'`);
      const invs = await tx.select({ number: s.invoices.number, patientId: s.invoices.patientId }).from(s.invoices).where(eq(s.invoices.organizationId, org.id));
      const max = await tx.execute<{ n: number }>(sql`select max(number)::int as n from patients where organization_id = ${org.id}`);
      return { p, invs, max: max.rows[0].n };
    });
    expect(res.p.externalIds).toEqual({ legacyExcel: 12_345_678 });
    expect(res.p.number).toBeLessThan(10);
    // Nummernvergabe nicht hinter die große ID verschoben
    expect(res.max).toBeLessThan(10);
    expect(res.invs.filter((i) => i.number === "R2026-0003" || i.number === "SR2026-0001").map((i) => i.patientId)).toEqual([res.p.id, res.p.id]);
    await pool.end();
  });

  it("Runde 4 R5: Zahlungen mit Datum heute oder in der Zukunft (Berliner Import-Tag) werden nicht als Zahlungszeile übernommen", async () => {
    const { pool, org, user, inOrg } = await freshOrg("r5");
    const parsed = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    // Import-Tag 09.03.2026: R2026-0001 (02.03.) vorher → Zahlung; Q2026-0002 (09.03.) heute, SR2026-0001 (30.04.) Zukunft → keine
    const sum = await inOrg((tx) => persistImport(tx as never, org.id, parsed, user.id, { today: "2026-03-09" }));
    const res = await inOrg(async (tx) => {
      const invs = await tx.select({ id: s.invoices.id, number: s.invoices.number, paidCents: s.invoices.paidCents, status: s.invoices.status }).from(s.invoices).where(eq(s.invoices.organizationId, org.id));
      const pays = await tx.select({ invoiceId: s.payments.invoiceId, paidAt: s.payments.paidAt }).from(s.payments).where(eq(s.payments.organizationId, org.id));
      return { invs, pays };
    });
    const byNumber = new Map(res.invs.map((i) => [i.number, i]));
    const paidInvoices = new Set(res.pays.map((p) => p.invoiceId));
    expect(paidInvoices.has(byNumber.get("R2026-0001")!.id)).toBe(true);
    expect(paidInvoices.has(byNumber.get("Q2026-0002")!.id)).toBe(false);
    expect(paidInvoices.has(byNumber.get("SR2026-0001")!.id)).toBe(false);
    expect(res.pays.every((p) => p.paidAt.getTime() < new Date("2026-03-09T00:00:00+01:00").getTime())).toBe(true);
    // Betrag/Status bleiben an der Rechnung
    expect(byNumber.get("Q2026-0002")).toMatchObject({ paidCents: 6500, status: "partially_paid" });
    expect(byNumber.get("SR2026-0001")).toMatchObject({ paidCents: 13000, status: "paid" });
    const futureWarnings = sum.warnings.filter((w) => w.message === FUTURE_PAYMENT_WARNING);
    expect(futureWarnings.map((w) => w.row).sort()).toEqual([3, 7]);
    expect(FUTURE_PAYMENT_WARNING).toBe("Zahlungsdatum heute oder in der Zukunft – Betrag nur an der Rechnung als bezahlt vermerkt, ohne Zahlungsbuchung und ohne Kasse. Bei Zahlung per Gutschein bitte den Gutscheinstand prüfen.");
    await pool.end();
  });
});
