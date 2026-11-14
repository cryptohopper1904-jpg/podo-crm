/**
 * Betreiber-Dashboard: liefert NUR Zahlen/Zeitstempel – nie Patientennamen, Kontaktdaten, Akteninhalte oder Rechnungsempfänger.
 * Prüft (1) die Form des Ergebnisses auf PII-artige Feldnamen und (2), dass eingesetzte Testdaten nirgends im Ergebnis auftauchen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

/** Feldnamen, die auf personenbezogene Daten oder Inhalte hindeuten */
const PII_KEY = /(first|last|full)?name$|email|mail$|phone|mobile|street|zip|city|address|birth|insur|recipient|sent_?to|iban|note|finding|text|summary|transcript|caller|subject|body|title|caption|diagnos|reason|patientId|author/i;
/** Ausnahmen: Name der Praxis (Geschäftskunde) und Zähler-Schlüssel */
const ALLOWED_KEYS = new Set(["practiceName", "emailsSent", "email"]);

function keysDeep(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => keysDeep(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(`${path}.${k}`); keysDeep(x, `${path}.${k}`, out); }
  return out;
}

function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  else out.push(v);
  return out;
}

(TEST_DB ? describe : describe.skip)("Plattform-Nutzungsdaten (DB)", () => {
  const f = fixtures(TEST_DB!);
  let stats: typeof import("./platform-stats");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    stats = await import("./platform-stats");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("zählt je Praxis, liefert keine personenbezogenen Felder und keine Inhalte", async () => {
    const org = await f.org({ phone: "030 999 888 77" });
    const patient = await f.patient(org, { lastName: "Geheimnachname", firstName: "Vertraulich", email: "geheim.patient@example.org", phoneMobile: "0151 2345678" });
    await f.invoice(org, patient, 4200);
    await f.invoice(org, patient, 800);
    await f.asOrg(org, (c) =>
      c.query(
        "insert into appointments (organization_id, patient_id, starts_at, ends_at, source, title, notes) values ($1,$2, now(), now() + interval '30 min', 'online', 'Online-Anfrage: G. V. · Geheimtermin', 'Notiz Geheimnis'), ($1,$2, now() - interval '1 hour', now(), 'portal', null, null)",
        [org, patient],
      ),
    );
    await f.asOrg(org, (c) => c.query("insert into audit_log (organization_id, action, meta) values ($1, 'ai.reply_suggestion', '{}'), ($1, 'prescription.ocr', '{}')", [org]));

    const u = await stats.practiceUsage(org);
    expect(u).not.toBeNull();
    const cur = u!.months.at(-1)!;
    expect(cur.invoicesIssued).toBe(2);
    expect(cur.revenueCents).toBe(5000);
    expect(cur.appointments).toBe(2);
    expect(cur.onlineBookings).toBe(1);
    expect(cur.portalBookings).toBe(1);
    expect(cur.aiUses).toBe(1);
    expect(cur.ocrUses).toBe(1);
    expect(u!.customersTotal).toBe(1);
    expect(u!.modules).toMatchObject({ kalender: true, rechnungen: true, onlineBuchung: true, ki: true, ocr: true, telefon: false });
    expect(u!.lastActivityAt).not.toBeNull();
    expect(u!.months).toHaveLength(stats.USAGE_MONTHS);

    // 1) Form: keine PII-artigen Feldnamen
    const suspicious = keysDeep(u).filter((p) => {
      const k = p.split(".").pop()!.replace(/\[\d+\]$/, "");
      return !ALLOWED_KEYS.has(k) && PII_KEY.test(k);
    });
    expect(suspicious).toEqual([]);

    // 2) Werte: nur Zahlen, Wahrheitswerte, null oder kurze Kennungen/Zeitstempel
    for (const v of leaves(u)) {
      expect(["number", "boolean", "string"].includes(typeof v) || v === null, String(v)).toBe(true);
    }
    const json = JSON.stringify(u);
    for (const secret of ["Geheimnachname", "Vertraulich", "geheim.patient", "0151", "Geheimtermin", "Notiz", "030 999"]) expect(json).not.toContain(secret);
  });

  it("Plattform-Gesamtsicht: gleiche Form ohne PII, Summen über alle Praxen", async () => {
    const all = await stats.platformUsage(50);
    expect(all.summary.practices).toBe(all.practices.length);
    expect(all.summary.months).toHaveLength(stats.USAGE_MONTHS);
    const suspicious = keysDeep([all.summary, all.practices]).filter((p) => {
      const k = p.split(".").pop()!.replace(/\[\d+\]$/, "");
      return !ALLOWED_KEYS.has(k) && PII_KEY.test(k) && !/byPlan|byStatus/.test(p);
    });
    expect(suspicious).toEqual([]);
    expect(Object.keys(all.health).sort()).toEqual(["backup", "migrations", "retention"]);
  });

  it("lastMonths: Monatsfolge über den Jahreswechsel", () => {
    expect(stats.lastMonths(3, "2026-02-10")).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});
