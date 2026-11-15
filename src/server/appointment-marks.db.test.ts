/**
 * Kalender-Symbole N/R (DB): Neupatient:in-Regel (frühere Termine, Doku, Excel-Import), Rechnungsstand über
 * invoice_lines.appointment_id, Mandantentrennung und Recht auf Belege (erfundene Daten).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Kalender-Symbole N/R (DB)", () => {
  const f = fixtures(TEST_DB!);
  let marks: typeof import("./appointment-marks");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    marks = await import("./appointment-marks");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authOf = (org: string, user: string, invoices = true) =>
    ({ organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Test" }, support: null, can: (p: string) => (p.startsWith("invoices.") ? invoices : true) }) as never;

  type Row = { id: string; status: string; endsAt: Date; patientId: string | null };
  const appt = (org: string, patient: string | null, startsAt: string, status = "planned"): Promise<Row> =>
    f.asOrg(org, async (c) => {
      const r = await c.query(
        "insert into appointments (organization_id, patient_id, starts_at, ends_at, status, title) values ($1,$2,$3::timestamptz,$3::timestamptz + interval '45 minutes',$4,'Behandlung') returning id, ends_at",
        [org, patient, startsAt, status],
      );
      return { id: r.rows[0].id, status, endsAt: r.rows[0].ends_at, patientId: patient };
    });
  /** Beleg mit Position zum Termin; status issued/cancelled bleibt nach dem Ausstellen, draft bleibt Entwurf */
  const bill = (org: string, apptId: string, status: "issued" | "draft" | "cancelled", kind = "invoice") =>
    f.asOrg(org, async (c) => {
      const inv = (await c.query("insert into invoices (organization_id, status, kind) values ($1,'draft',$2) returning id", [org, kind])).rows[0].id;
      await c.query("insert into invoice_lines (organization_id, invoice_id, appointment_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'Behandlung',4500,4500,0,1)", [org, inv, apptId]);
      if (status !== "draft") {
        await c.query("update invoices set status='issued', number=$2, issued_at=current_date, due_at=current_date + 14, total_cents=4500, net_cents=4500 where id=$1", [inv, `NR-${Math.random().toString(36).slice(2, 9)}`]);
        if (status === "cancelled") await c.query("update invoices set status='cancelled' where id=$1", [inv]);
      }
    });

  const now = new Date("2030-05-15T12:00:00Z");

  it("Neupatient:in: erster Besuch ohne frühere Termine/Doku/Import; Serie nur am ersten Termin", async () => {
    const org = await f.org();
    const user = await f.user(org);
    const auth = authOf(org, user);
    // nacheinander (Patientennummer = max + 1)
    const ps: string[] = [];
    for (const n of ["Alt", "Neu", "Abgesagt", "NichtDa", "Import", "Doku", "Gleich"]) ps.push(await f.patient(org, { lastName: n }));
    const [pAlt, pNeu, pAbgesagt, pNichtDa, pImport, pDoku, pGleich] = ps;
    await f.asOrg(org, (c) => c.query("update patients set external_ids = '{\"legacyExcel\": 17}'::jsonb where id = $1", [pImport]));
    await f.asOrg(org, (c) => c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3,'2030-01-10 10:00+01','h')", [org, pDoku, user]));

    await appt(org, pAlt, "2030-04-01 09:00+02", "done");
    const alt = await appt(org, pAlt, "2030-05-15 09:00+02", "done");
    const neu1 = await appt(org, pNeu, "2030-05-20 09:00+02", "confirmed");
    const neu2 = await appt(org, pNeu, "2030-05-27 09:00+02", "planned");
    await appt(org, pAbgesagt, "2030-04-01 09:00+02", "cancelled");
    const abgesagt = await appt(org, pAbgesagt, "2030-05-20 10:00+02");
    await appt(org, pNichtDa, "2030-04-01 09:00+02", "no_show");
    const nichtDa = await appt(org, pNichtDa, "2030-05-20 11:00+02");
    const imp = await appt(org, pImport, "2030-05-20 12:00+02");
    const doku = await appt(org, pDoku, "2030-05-20 13:00+02");
    const g1 = await appt(org, pGleich, "2030-05-21 09:00+02");
    const g2 = await appt(org, pGleich, "2030-05-21 09:00+02");
    const storniert = await appt(org, pNeu, "2030-05-01 09:00+02", "cancelled");
    const ohne = await appt(org, null, "2030-05-20 14:00+02");

    const m = await marks.appointmentMarks(auth, [alt, neu1, neu2, abgesagt, nichtDa, imp, doku, g1, g2, storniert, ohne].map((r) => r.id), now);
    const n = (r: Row) => m.get(r.id)?.newPatient ?? false;
    expect(n(alt)).toBe(false);
    expect(n(neu1)).toBe(true);
    expect(n(neu2)).toBe(false);
    expect(n(abgesagt)).toBe(true);
    expect(n(nichtDa)).toBe(true);
    expect(n(imp)).toBe(false);
    expect(n(doku)).toBe(false);
    // gleiche Startzeit: genau einer trägt das N
    expect([n(g1), n(g2)].filter(Boolean)).toHaveLength(1);
    expect(n(storniert)).toBe(false);
    expect(m.has(ohne.id)).toBe(false);
  });

  it("Rechnung: grau ohne bzw. mit Entwurf/storniertem Beleg, grün mit ausgestelltem; nur erledigt oder vorbei", async () => {
    const org = await f.org();
    const user = await f.user(org);
    const p = await f.patient(org);
    await appt(org, p, "2030-04-01 09:00+02", "done");
    const bezahlt = await appt(org, p, "2030-05-02 09:00+02", "done");
    const offen = await appt(org, p, "2030-05-03 09:00+02", "done");
    const entwurf = await appt(org, p, "2030-05-04 09:00+02", "done");
    const storno = await appt(org, p, "2030-05-05 09:00+02", "done");
    const vorbei = await appt(org, p, "2030-05-06 09:00+02", "confirmed");
    const kuenftig = await appt(org, p, "2030-05-20 09:00+02", "confirmed");
    const nichtDa = await appt(org, p, "2030-05-07 09:00+02", "no_show");
    await bill(org, bezahlt.id, "issued");
    await bill(org, entwurf.id, "draft");
    await bill(org, storno.id, "cancelled");

    const rows = [bezahlt, offen, entwurf, storno, vorbei, kuenftig, nichtDa];
    const m = await marks.appointmentMarks(authOf(org, user), rows.map((x) => x.id), now);
    const r = (x: Row) => m.get(x.id)?.invoice ?? null;
    expect(r(bezahlt)).toBe("written");
    expect(r(offen)).toBe("open");
    expect(r(entwurf)).toBe("open");
    expect(r(storno)).toBe("open");
    expect(r(vorbei)).toBe("open");
    expect(r(kuenftig)).toBeNull();
    expect(r(nichtDa)).toBeNull();

    // ohne Recht auf Belege: kein R
    const ohneRecht = await marks.appointmentMarks(authOf(org, user, false), rows.map((x) => x.id), now);
    expect([...ohneRecht.values()].every((x) => x.invoice === null)).toBe(true);
  });

  it("Mandantentrennung: fremde Termine liefern nichts, fremde Vorgeschichte zählt nicht", async () => {
    const orgA = await f.org();
    const orgB = await f.org();
    const userA = await f.user(orgA);
    const pA = await f.patient(orgA, { lastName: "A" });
    const pB = await f.patient(orgB, { lastName: "B" });
    // Termin in B (erledigt, abgerechnet)
    const fremd = await appt(orgB, pB, "2030-05-02 09:00+02", "done");
    await bill(orgB, fremd.id, "issued");
    const eigen = await appt(orgA, pA, "2030-05-02 09:00+02", "done");
    // fremde Termin-ID mit Praxis A abgefragt: nichts; die Vorgeschichte in B zählt für A nicht
    const auth = authOf(orgA, userA);
    const m = await marks.appointmentMarks(auth, [fremd.id, eigen.id], now);
    expect(m.has(fremd.id)).toBe(false);
    expect(m.get(eigen.id)).toEqual({ newPatient: true, invoice: "open" });
    // ungültige IDs werden ignoriert
    expect((await marks.appointmentMarks(auth, ["kaputt"], now)).size).toBe(0);
    // Praxis B sieht ihren Termin weiterhin (R grün)
    expect((await marks.appointmentMarks(authOf(orgB, await f.user(orgB)), [fremd.id], now)).get(fremd.id)).toEqual({ newPatient: true, invoice: "written" });
  });
});
