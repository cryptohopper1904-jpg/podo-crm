/**
 * Gesamt-Review M1: Öffentliche Buchung /buchen prüft serverseitig Freigabe, Leistungsliste, Arbeitszeiten,
 * Abwesenheiten und Buchungsfenster – nur exakt angebotene Startzeiten (wie Portal und Telefon).
 * AppSec L1: Praxis mit abgelaufenem Abo/Testphase oder beantragter Löschung ist von außen nicht mehr buchbar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Öffentliche Buchung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let pb: typeof import("./portal-booking");
  let fmt: typeof import("@/lib/format");
  // Montag, 4. März 2030, 07:00 Berlin
  const now = new Date("2030-03-04T06:00:00Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    pb = await import("./portal-booking");
    fmt = await import("@/lib/format");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function practice(settings: Record<string, unknown> = {}) {
    const org = await f.org({ settings: { onlineBooking: { enabled: true, ...settings } } });
    await f.pool.query("update organizations set state = 'BB' where id = $1", [org]);
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
    const ids = await f.asOrg(org, async (c) => {
      for (let wd = 1; wd <= 5; wd++) await c.query("insert into working_hours (organization_id, user_id, weekday, start_time, end_time) values ($1,$2,$3,'09:00','12:00')", [org, u, wd]);
      await c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2030-03-06','2030-03-06','vacation')", [org, u]);
      const pk = (await c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'PK','Komplexbehandlung',6500,60,'treatment') returning id", [org])).rows[0].id as string;
      const kos = (await c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'KOS','Kosmetik',4000,30,'cosmetic') returning id", [org])).rows[0].id as string;
      return { pk, kos };
    });
    return { org, ...ids };
  }
  const at = (d: string, t: string) => fmt.berlinToUtc(d, t);

  it("freier Slot innerhalb der Arbeitszeit: ok", async () => {
    const p = await practice();
    expect(await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).toMatchObject({ ok: true, service: { id: p.pk } });
  });

  it("Urlaub, außerhalb der Arbeitszeit, Wochenende, krumme Startzeit, zu weit in der Zukunft: abgelehnt", async () => {
    const p = await practice();
    for (const [d, t] of [["2030-03-06", "09:00"], ["2030-03-05", "14:00"], ["2030-03-09", "09:00"], ["2030-03-05", "09:10"], ["2030-03-05", "03:00"], ["2030-04-30", "09:00"]]) {
      expect((await pb.checkPublicSlot(p.org, p.pk, at(d, t), now)).ok, `${d} ${t}`).toBe(false);
    }
  });

  it("Leistungsliste und Freigabe werden serverseitig geprüft", async () => {
    const p = await practice({ serviceCodes: ["KOS"] });
    expect(await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).toEqual({ ok: false, error: "Diese Leistung ist online nicht buchbar." });
    expect((await pb.checkPublicSlot(p.org, p.kos, at("2030-03-05", "09:00"), now)).ok).toBe(true);
    const off = await practice({ enabled: false });
    expect((await pb.checkPublicSlot(off.org, off.pk, at("2030-03-05", "09:00"), now)).ok).toBe(false);
    expect(await pb.publicBookingOptions(off.org, now)).toBeNull();
  });

  it("angezeigte Zeiten berücksichtigen Abwesenheiten und belegte Termine", async () => {
    const p = await practice();
    await f.asOrg(p.org, (c) => c.query("insert into appointments (organization_id, starts_at, ends_at, status) values ($1,$2,$3,'planned')", [p.org, at("2030-03-05", "09:00"), at("2030-03-05", "10:00")]));
    const o = await pb.publicBookingOptions(p.org, now);
    expect(o?.days.map((d) => d.date)).not.toContain("2030-03-06");
    const tue = o?.days.find((d) => d.date === "2030-03-05");
    expect(tue?.slots[60]).toEqual(["10:00", "10:30", "11:00"]);
    expect((await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).ok).toBe(false);
  });

  describe("AppSec L1: gesperrte oder gekündigte Praxis", () => {
    const slot = () => at("2030-03-05", "09:00");

    it("Testphase abgelaufen (Nur-Lesen): keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set plan = 'trial', subscription_status = 'trialing', trial_ends_at = '2030-03-01T00:00:00Z' where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect(await pb.checkPublicSlot(p.org, p.pk, slot(), now)).toEqual({ ok: false, error: "Die Online-Buchung ist derzeit nicht verfügbar." });
    });

    it("Abo gekündigt und Kulanz vorbei: keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set plan = 'praxis', subscription_status = 'canceled', current_period_end = '2030-01-01T00:00:00Z' where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect((await pb.checkPublicSlot(p.org, p.pk, slot(), now)).ok).toBe(false);
    });

    it("Löschung beantragt: keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set deletion_requested_at = now() where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect(await pb.checkPublicSlot(p.org, p.pk, slot(), now)).toEqual({ ok: false, error: "Die Online-Buchung ist derzeit nicht verfügbar." });
    });

    it("normale Praxis unverändert buchbar", async () => {
      const p = await practice();
      expect((await pb.publicBookingOptions(p.org, now))?.days.length).toBeGreaterThan(0);
      expect((await pb.checkPublicSlot(p.org, p.pk, slot(), now)).ok).toBe(true);
    });
  });
});
