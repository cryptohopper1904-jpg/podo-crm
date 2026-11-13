/**
 * Sammelrechnung mit künftiger Anzahlung: vorausgewählt (angerechnet) werden nur Anzahlungen, deren Leistung erbracht
 * ist (verknüpfter Termin bis heute). Anzahlungen für künftige Termine oder ohne Termin bleiben anwählbar.
 * Dazu: Personenwahl für eine Anzahlung ohne Termin (nur eigene Praxis, nicht archiviert, keine gelöschten Kontaktdaten).
 * DB, erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";
import { depositCheckHint, depositPreselected } from "@/lib/deposit-rules";

(TEST_DB ? describe : describe.skip)("Anzahlungen in der Sammelrechnung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let billing: typeof import("./appointment-billing");
  let today: string;
  let year: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    invoices = await import("./invoices");
    billing = await import("./appointment-billing");
    today = (await import("@/lib/format")).berlinDateIso();
    year = Number(today.slice(0, 4));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function setup() {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const auth = { organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true } as never;
    return { org, user, auth };
  }

  it("Sammelrechnung mit künftiger Anzahlung: nur erbrachte Leistungen vorausgewählt, die übrigen anwählbar mit Hinweis", async () => {
    const { org, user, auth } = await setup();
    const patient = await f.patient(org, { lastName: "Spange" });
    const appointment = (startsAt: string) =>
      f.asOrg(org, async (c) =>
        (
          await c.query(
            `insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, source, status, title)
             values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '45 minutes','manual','planned','Spange') returning id`,
            [org, patient, user, startsAt],
          )
        ).rows[0].id as string,
      );
    const deposit = (appointmentId: string | null, amountCents: number) =>
      invoices.createDeposit(auth, { patientId: patient, appointmentId, treatmentRecordId: null, description: "Anzahlung: Nagelspange", amountCents, vatRate: 0, method: "cash", notes: null });
    const in3Days = new Date(Date.now() + 3 * 86_400_000).toISOString();
    // a) Anzahlung vor dem Termin, der Termin hat inzwischen stattgefunden (gestern)
    const done = await appointment(in3Days);
    const depDone = await deposit(done, 1000);
    await f.asOrg(org, (c) => c.query("update appointments set starts_at = now() - interval '1 day', ends_at = now() - interval '1 day' + interval '45 minutes' where id = $1", [done]));
    // b) Termin noch in der Zukunft
    const future = await appointment(in3Days);
    const depFuture = await deposit(future, 2000);
    // c) ohne Termin
    const depFree = await deposit(null, 3000);

    const form = await invoices.invoiceFormData(auth, patient, year);
    const byId = new Map(form.openDeposits.map((d) => [d.id, d]));
    expect(byId.get(depDone.id)!.serviceDay! <= today).toBe(true);
    expect(byId.get(depFuture.id)!.serviceDay! > today).toBe(true);
    expect(byId.get(depFree.id)!.serviceDay).toBeNull();

    const ctx = { today: form.today, receiptsYear: year, presetRefs: new Set<string>() };
    expect(form.openDeposits.filter((d) => depositPreselected("collective", d, ctx)).map((d) => d.id)).toEqual([depDone.id]);
    expect(depositCheckHint(byId.get(depDone.id)!, today)).toBeNull();
    expect(depositCheckHint(byId.get(depFuture.id)!, today)).toBe("erst nach dem Termin anrechenbar");
    expect(depositCheckHint(byId.get(depFree.id)!, today)).toMatch(/Leistung erbracht\? Bitte prüfen/);

    // Vorschlag „Sammelrechnung des Jahres“ kennt den Leistungstag ebenso
    const sug = await billing.patientYearSuggestion(auth, patient, year);
    expect(new Map(sug!.deposits.map((d) => [d.id, d.serviceDay])).get(depFuture.id)).toBe(byId.get(depFuture.id)!.serviceDay);

    // abgesagter bzw. versäumter Termin: Leistung gilt nicht als erbracht – nicht vorausgewählt, Hinweis auf Erstattung
    for (const status of ["cancelled", "no_show"]) {
      await f.asOrg(org, (c) => c.query("update appointments set status = $2 where id = $1", [done, status]));
      const after = await invoices.invoiceFormData(auth, patient, year);
      const d = after.openDeposits.find((x) => x.id === depDone.id)!;
      expect(d).toMatchObject({ serviceDay: null, appointmentMissed: true });
      expect(depositPreselected("collective", d, ctx)).toBe(false);
      expect(depositCheckHint(d, today)).toBe("Termin abgesagt/versäumt – bitte prüfen, ggf. erstatten");
      const s2 = await billing.patientYearSuggestion(auth, patient, year);
      expect(s2!.deposits.find((x) => x.id === depDone.id)).toMatchObject({ serviceDay: null, appointmentMissed: true });
    }
    await f.asOrg(org, (c) => c.query("update appointments set status = 'done' where id = $1", [done]));

    // Server: Anzahlung zu einem künftigen Termin ist nicht anrechenbar – auch nicht auf eine Rechnung mit freier Position
    const base = { patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [] };
    const free = [{ serviceId: null, treatmentRecordId: null, appointmentId: null, description: "Nagelspange (Material)", quantity: 1, factor: 1, unitPriceCents: 5000, vatRate: 0 }];
    for (const kind of ["invoice", "collective"] as const) {
      await expect(invoices.createInvoice(auth, { ...base, kind, lines: free, depositIds: [depFuture.id] } as never)).rejects.toThrow(
        new RegExp(`Die Anzahlung ${depFuture.number} gehört zu einem künftigen Termin \\(\\d{2}\\.\\d{2}\\.\\d{4}\\) – erst nach dem Termin anrechenbar\\.`),
      );
    }
    // Anzahlung ohne Termin: anrechenbar (nach Prüfung)
    const inv = await invoices.createInvoice(auth, { ...base, kind: "invoice", lines: free, depositIds: [depFree.id] } as never);
    expect(inv).toMatchObject({ depositCents: 3000, status: "partially_paid" });

    // Anzahlung zum inzwischen stattgefundenen Termin: auf die Sammelrechnung anrechenbar
    const sr = await invoices.createInvoice(auth, {
      kind: "collective",
      patientId: patient,
      billingContactId: null,
      issuedAt: today,
      dueDays: 14,
      therapeuticConfirmed: true,
      notes: null,
      payments: [],
      lines: [{ serviceId: null, treatmentRecordId: null, appointmentId: done, description: "Nagelspange", quantity: 1, factor: 1, unitPriceCents: 1000, vatRate: 0 }],
      depositIds: [depDone.id],
    } as never);
    expect(sr).toMatchObject({ depositCents: 1000, status: "paid" });
  });

  it("Person für Anzahlung ohne Termin: nur eigene Praxis, nicht archiviert, keine gelöschten Kontaktdaten", async () => {
    const { org, auth } = await setup();
    const other = await setup();
    const mine = await f.patient(org, { lastName: "Eigen", firstName: "Eva" });
    const foreign = await f.patient(other.org, { lastName: "Fremd" });
    const archived = await f.patient(org, { lastName: "Alt" });
    await f.asOrg(org, (c) => c.query("update patients set archived_at = now() where id = $1", [archived]));
    const erased = await f.patient(org, { lastName: "Gelöscht" });
    await f.asOrg(org, (c) => c.query("update patients set contact_erased_at = now() where id = $1", [erased]));

    expect(await billing.depositPatient(auth, mine)).toMatchObject({ id: mine, name: "Eva Eigen" });
    expect(await billing.depositPatient(auth, foreign)).toBeNull();
    expect(await billing.depositPatient(auth, archived)).toBeNull();
    expect(await billing.depositPatient(auth, erased)).toBeNull();
    expect(await billing.depositPatient(auth, "kein-uuid")).toBeNull();
    expect(await billing.depositPatient(auth, null)).toBeNull();
    // Server lehnt auch direkt ab (fremde Praxis: nicht gefunden)
    await expect(
      invoices.createDeposit(auth, { patientId: foreign, appointmentId: null, treatmentRecordId: null, description: "Nagelspange", amountCents: 1000, vatRate: 0, method: "cash", notes: null }),
    ).rejects.toThrow(/nicht gefunden/);
  });
});
