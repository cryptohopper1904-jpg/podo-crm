/** Kundenportal gegen PostgreSQL: Token-Auflösung, Rechnungs-Zugehörigkeit (fremde Rechnung → kein PDF), Absage-Regel. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { hashPortalToken, newPortalToken } from "@/lib/portal";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Kundenportal (DB)", () => {
  const f = fixtures(TEST_DB!);
  let core: typeof import("./portal-core");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    core = await import("./portal-core");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function link(org: string, patientId: string, opts: { expiresInMs?: number; revoked?: boolean } = {}) {
    const token = newPortalToken();
    await f.pool.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at, revoked_at) values ($1,$2,'portal',$3,$4,$5)", [
      org,
      patientId,
      hashPortalToken(token),
      new Date(Date.now() + (opts.expiresInMs ?? 86400_000)),
      opts.revoked ? new Date() : null,
    ]);
    return token;
  }

  it("liefert das PDF nur für Rechnungen der Person des Links", async () => {
    const org = await f.org();
    const otherOrg = await f.org();
    const me = await f.patient(org, { firstName: "Erika" });
    const other = await f.patient(org, { lastName: "Andere", firstName: "Anna" });
    const mine = await f.invoice(org, me, 6500);
    const notMine = await f.invoice(org, other, 4200);
    const foreign = await f.invoice(otherOrg, await f.patient(otherOrg), 1000);

    const l = await core.resolvePortalLink(await link(org, me));
    expect(l).not.toBeNull();
    const pdf = await core.portalInvoicePdf(l!, mine);
    expect(pdf && Buffer.from(pdf.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await core.portalInvoicePdf(l!, notMine)).toBeNull();
    expect(await core.portalInvoicePdf(l!, foreign)).toBeNull();
    expect(await core.portalInvoicePdf(l!, "kein-uuid")).toBeNull();

    const view = await core.loadPortalView(l!);
    expect(view?.firstName).toBe("Erika");
    expect(view?.invoices.map((i) => i.id)).toEqual([mine]);
  });

  it("abgelaufene/widerrufene/ungültige Tokens werden abgelehnt", async () => {
    const org = await f.org();
    const p = await f.patient(org);
    expect(await core.resolvePortalLink(await link(org, p, { expiresInMs: -1000 }))).toBeNull();
    expect(await core.resolvePortalLink(await link(org, p, { revoked: true }))).toBeNull();
    expect(await core.resolvePortalLink(newPortalToken())).toBeNull();
    expect(await core.resolvePortalLink("x")).toBeNull();
  });

  it("Absage nur ≥ 24 h vorher und nur eigene Termine; Nachricht landet im Posteingang", async () => {
    const org = await f.org();
    const p = await f.patient(org);
    const other = await f.patient(org, { lastName: "Andere" });
    const mk = (pid: string, hours: number) =>
      f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at) values ($1,$2,$3,$4) returning id", [org, pid, new Date(Date.now() + hours * 3600_000), new Date(Date.now() + (hours + 1) * 3600_000)])).rows[0].id as string);
    const later = await mk(p, 72);
    const soon = await mk(p, 5);
    const foreign = await mk(other, 72);
    const l = (await core.resolvePortalLink(await link(org, p)))!;
    expect((await core.cancelPortalAppointment(l, soon)).ok).toBe(false);
    expect((await core.cancelPortalAppointment(l, foreign)).ok).toBe(false);
    expect((await core.cancelPortalAppointment(l, later)).ok).toBe(true);
    expect((await core.cancelPortalAppointment(l, later)).ok).toBe(false);
    const rows = await f.asOrg(org, async (c) => ({
      status: (await c.query("select status from appointments where id = $1", [later])).rows[0].status,
      foreign: (await c.query("select status from appointments where id = $1", [foreign])).rows[0].status,
      inbox: (await c.query("select count(*)::int as n from messages where patient_id = $1 and direction = 'inbound'", [p])).rows[0].n,
    }));
    expect(rows).toEqual({ status: "cancelled", foreign: "planned", inbox: 1 });
  });
});
