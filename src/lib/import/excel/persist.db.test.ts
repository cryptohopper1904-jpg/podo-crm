/** Echter Datenbanktest des Excel-Imports (nur mit TEST_DATABASE_URL; erfundene Daten). */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as s from "@/db/schema";
import { parseWorkbook } from "./parse";
import { persistImport } from "./persist";
import { buildWorkbook } from "./excel-import.test";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Excel-Import gegen PostgreSQL (RLS, Trigger)", () => {
  it("importiert Patienten, Leistungen, Gutscheine, Rechnungen und Fixkosten", async () => {
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema: s });
    const [org] = await db.insert(s.organizations).values({ name: "Import-Test", slug: `imp-${Date.now()}` }).returning();
    const [user] = await db.insert(s.users).values({ email: `imp-${Date.now()}@example.org`, name: "T", passwordHash: "x" }).returning();
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
});
