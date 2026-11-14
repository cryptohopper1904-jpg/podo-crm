/**
 * Neue Patient:in aus dem Fenster „Neuer Termin“ (quickCreatePatientAction, DB): Recht patients.write, Prüfung,
 * Dublettenwarnung (archivierte gekennzeichnet) mit „trotzdem anlegen“, Idempotenz per Formular-Token
 * (Mehrfach-Enter → genau eine Person) und Terminanlage für archivierte Patient:innen gesperrt. Erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const authState = vi.hoisted(() => ({ org: "", user: "", perms: [] as string[], deny: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({
  requireAuth: async (perm?: string) => {
    if (perm) authState.perms.push(perm);
    if (perm && authState.deny.includes(perm)) throw new Error(`NEXT_REDIRECT:/nur-lesen (${perm})`);
    return { organization: { id: authState.org, state: "BE" }, user: { id: authState.user }, role: "owner", support: null, can: (p: string) => !authState.deny.includes(p) };
  },
  requestMeta: async () => ({ ip: null }),
}));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
let seq = 0;
const token = () => `test-token-${Date.now().toString(36)}-${(seq++).toString().padStart(4, "0")}`;

(TEST_DB ? describe : describe.skip)("Neue Patient:in im Terminfenster (DB)", () => {
  const f = fixtures(TEST_DB!);
  let actions: typeof import("@/app/(app)/kalender/actions");
  let ap: typeof import("./appointments");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    actions = await import("@/app/(app)/kalender/actions");
    ap = await import("./appointments");
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
    Object.assign(authState, { org, user, perms: [], deny: [] });
    return { org, user };
  }
  const patientsOf = async (org: string) =>
    (await f.asOrg(org, (c) => c.query("select id, number, first_name, last_name, phone_mobile, archived_at from patients where organization_id = $1 order by number", [org]))).rows;

  it("verlangt patients.write – ohne Recht wird nichts angelegt", async () => {
    const { org } = await setup();
    authState.deny = ["patients.write"];
    await expect(actions.quickCreatePatientAction(undefined, fd({ lastName: "Ohnerecht", requestId: token() }))).rejects.toThrow(/nur-lesen/);
    expect(authState.perms).toEqual(["patients.write"]);
    expect(await patientsOf(org)).toHaveLength(0);
  });

  it("prüft Eingaben (Nachname, E-Mail, Geburtsdatum, Formular-Token)", async () => {
    const { org } = await setup();
    expect(await actions.quickCreatePatientAction(undefined, fd({ firstName: "Nur", requestId: token() }))).toEqual({ error: "Nachname fehlt" });
    expect(await actions.quickCreatePatientAction(undefined, fd({ lastName: "Mail", email: "kein-at", requestId: token() }))).toEqual({ error: "E-Mail ungültig" });
    expect(await actions.quickCreatePatientAction(undefined, fd({ lastName: "Geb", birthDate: "31.2.", requestId: token() }))).toEqual({ error: "Geburtsdatum als TT.MM.JJJJ" });
    expect(await actions.quickCreatePatientAction(undefined, fd({ lastName: "Token" }))).toMatchObject({ error: expect.stringMatching(/Formular/) });
    expect(await actions.quickCreatePatientAction(undefined, fd({ lastName: "Token", requestId: "kurz" }))).toMatchObject({ error: expect.stringMatching(/Formular/) });
    expect(await patientsOf(org)).toHaveLength(0);
  });

  it("legt an (Geburtsdatum TT.MM.JJJJ), nächste Nummer, Audit mit Anfrage-Kennung", async () => {
    const { org, user } = await setup();
    await f.patient(org, { lastName: "Vorhanden" });
    const id = token();
    const r = await actions.quickCreatePatientAction(undefined, fd({ firstName: " Erfunda ", lastName: "Neumann", phoneMobile: "0151 0000001", birthDate: "03.04.1950", requestId: id }));
    expect(r).toEqual({ patient: { id: expect.any(String), number: 2, firstName: "Erfunda", lastName: "Neumann" } });
    const rows = await f.asOrg(org, (c) => c.query("select birth_date::text b, source from patients where id = $1", [r!.patient!.id]));
    expect(rows.rows[0]).toEqual({ b: "1950-04-03", source: "manual" });
    const audit = (await f.asOrg(org, (c) => c.query("select user_id, entity_id, meta from audit_log where organization_id = $1 and action = 'patient.create'", [org]))).rows;
    expect(audit).toEqual([{ user_id: user, entity_id: r!.patient!.id, meta: { via: "termin", requestId: id } }]);
  });

  it("Mehrfach-Enter: dieselbe Anfrage gleichzeitig und nacheinander → genau eine Patient:in", async () => {
    const { org } = await setup();
    const form = { firstName: "Erfunda", lastName: "Dreifach", phoneMobile: "0151 0000003", requestId: token() };
    const parallel = await Promise.all([1, 2, 3].map(() => actions.quickCreatePatientAction(undefined, fd(form))));
    const ids = new Set(parallel.map((r) => r?.patient?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
    // spätere Wiederholung (z. B. erneutes Senden): keine Dublettenwarnung gegen sich selbst, dieselbe Person
    expect((await actions.quickCreatePatientAction(undefined, fd(form)))?.patient?.id).toBe([...ids][0]);
    expect(await patientsOf(org)).toHaveLength(1);
    // ein neues Formular (neues Token) mit „trotzdem anlegen“ legt dagegen bewusst eine zweite Person an
    expect((await actions.quickCreatePatientAction(undefined, fd({ ...form, requestId: token(), ignoreDuplicates: "1" })))?.patient).toBeTruthy();
    expect(await patientsOf(org)).toHaveLength(2);
  });

  it("Dublettenwarnung: Treffer per Telefon, archivierte gekennzeichnet; „trotzdem anlegen“ legt an", async () => {
    const { org } = await setup();
    const active = await f.patient(org, { lastName: "Doppelt", firstName: "Erika", phoneMobile: "0151 0000005" });
    const archived = await f.patient(org, { lastName: "Altakte", firstName: "Ernst", phoneMobile: "0151 0000005" });
    await f.asOrg(org, (c) => c.query("update patients set archived_at = now() where id = $1", [archived]));
    const form = { firstName: "Erika", lastName: "Doppelt", phoneMobile: "0151 0000005", requestId: token() };
    const r = await actions.quickCreatePatientAction(undefined, fd(form));
    expect(r?.patient).toBeUndefined();
    expect(r?.error).toMatch(/gibt es diese Person schon/);
    expect(r?.duplicates).toEqual([
      { id: active, number: 1, firstName: "Erika", lastName: "Doppelt", archived: false },
      { id: archived, number: 2, firstName: "Ernst", lastName: "Altakte", archived: true },
    ]);
    expect(await patientsOf(org)).toHaveLength(2);
    const forced = await actions.quickCreatePatientAction(undefined, fd({ ...form, ignoreDuplicates: "1" }));
    expect(forced?.patient).toMatchObject({ number: 3, lastName: "Doppelt" });
    expect(await patientsOf(org)).toHaveLength(3);
  });

  it("Terminanlage für archivierte oder fremde Patient:innen wird abgelehnt", async () => {
    const { org, user } = await setup();
    const archived = await f.patient(org, { lastName: "Archiviert" });
    await f.asOrg(org, (c) => c.query("update patients set archived_at = now() where id = $1", [archived]));
    const other = await f.org();
    const foreign = await f.patient(other, { lastName: "Fremd" });
    const input = (patientId: string) => ({
      patientId, therapistId: user, occurrences: [new Date("2031-05-06T08:00:00Z")], durationMin: 30, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
    });
    expect(await ap.createInternalAppointments(org, input(archived))).toEqual({ ok: false, error: ap.ARCHIVED_PATIENT_MSG });
    expect(await ap.createInternalAppointments(org, input(foreign))).toEqual({ ok: false, error: "Patient:in nicht gefunden." });
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int n from appointments where organization_id = $1", [org]))).rows[0].n).toBe(0);
    // über das Formular („Neuer Termin“) kommt dieselbe Meldung an
    const res = await actions.createAppointmentInDialogAction(undefined, fd({ patientId: archived, therapistId: user, date: "2031-05-06", time: "10:00", durationMin: "30" }));
    expect(res).toEqual({ error: ap.ARCHIVED_PATIENT_MSG });
  });
});
