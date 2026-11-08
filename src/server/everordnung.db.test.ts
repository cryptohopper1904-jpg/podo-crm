/** eVerordnung-Import: Entwurf mit Herkunft, verdichtete Daten, Dubletten (Vorab-Prüfung und Unique-Index). Erfundene Daten. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const bundle = (name: string) => readFileSync(path.join(__dirname, "../lib/everordnung/fixtures", name), "utf8");

(TEST_DB ? describe : describe.skip)("eVerordnung-Import (DB)", () => {
  const f = fixtures(TEST_DB!);
  let evo: typeof import("./everordnung");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    evo = await import("./everordnung");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authFor = (org: string, user: string, can: (p: string) => boolean = () => true) =>
    ({ organization: { id: org, name: "T" }, user: { id: user, name: "Test" }, can }) as never;

  it("Vorschau schlägt Person über KVNR vor, Import legt offenen Entwurf mit Herkunft und Zusammenfassung an", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    await f.asOrg(org, (c) => c.query("update patients set insurance_number = 'A123456780' where id = $1", [p]));
    const auth = authFor(org, user);

    const pre = await evo.previewEverordnung(auth, bundle("hmv-df-komplett.json"));
    if ("error" in pre) throw new Error(pre.error);
    expect(pre.duplicate).toBeNull();
    expect(pre.candidates.map((c) => c.id)).toEqual([p]);

    const res = await evo.importEverordnung(auth, bundle("hmv-df-komplett.json"), { patientId: p });
    if ("error" in res) throw new Error(res.error);
    const row = (await f.asOrg(org, (c) => c.query("select * from prescriptions where id = $1", [res.id]))).rows[0];
    expect(row).toMatchObject({
      patient_id: p,
      status: "open",
      source: "everordnung",
      external_ref: "170.000.000.000.001.01",
      diagnosis_group: "DF",
      icd10: "E11.74",
      units: 6,
      doctor_lanr: "999999901",
      doctor_bsnr: "999999900",
      therapy_report_requested: true,
      frequency_per_week: "1x alle 4-6 Wochen",
    });
    expect(row.positions).toEqual([{ position: "78100", label: "Podologische Komplexbehandlung", units: 6 }]);
    expect(row.import_data).toMatchObject({ format: "fhir-r4-bundle", kvnr: "A123456780", diagnosisGroup: "DF" });
    expect(JSON.stringify(row.import_data)).not.toContain("Musterfrau");

    // Wiederholter Import → freundlicher Fehler, Vorschau zeigt Dublette
    expect(await evo.importEverordnung(auth, bundle("hmv-df-komplett.json"), { patientId: p })).toEqual({ error: "Diese eVerordnung wurde bereits importiert." });
    const again = await evo.previewEverordnung(auth, bundle("hmv-df-komplett.json"));
    expect("duplicate" in again && again.duplicate).toEqual({ prescriptionId: res.id, patientId: p });
  });

  it("parallele Importe: Unique-Index greift, genau eine Verordnung", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org);
    const auth = authFor(org, user);
    const results = await Promise.all([1, 2, 3].map(() => evo.importEverordnung(auth, bundle("hmv-ui-minimal.json"), { patientId: p })));
    expect(results.filter((r) => "id" in r)).toHaveLength(1);
    expect(results.filter((r) => "error" in r).map((r) => ("error" in r ? r.error : ""))).toEqual(["Diese eVerordnung wurde bereits importiert.", "Diese eVerordnung wurde bereits importiert."]);
    const n = (await f.asOrg(org, (c) => c.query("select count(*)::int as n from prescriptions where external_ref = 'bundle-ui-0002'"))).rows[0].n;
    expect(n).toBe(1);
    // gleiche Kennung in anderer Praxis ist erlaubt
    const org2 = await f.org();
    const p2 = await f.patient(org2);
    expect("id" in (await evo.importEverordnung(authFor(org2, user), bundle("hmv-ui-minimal.json"), { patientId: p2 }))).toBe(true);
  });

  it("neue Person aus der eVerordnung; ohne Zuordnung kein Import; Rechte", async () => {
    const org = await f.org();
    const user = await f.user();
    expect(await evo.importEverordnung(authFor(org, user), bundle("hmv-ui-minimal.json"), {})).toEqual({ error: expect.stringMatching(/Person/) });
    const res = await evo.importEverordnung(authFor(org, user), bundle("hmv-ui-minimal.json"), { createPatient: true });
    if ("error" in res) throw new Error(res.error);
    const pat = (await f.asOrg(org, (c) => c.query("select last_name, first_name, birth_date::text as b, insurance_type, source from patients where id = $1", [res.patientId]))).rows[0];
    expect(pat).toEqual({ last_name: "Mustermann", first_name: "Max", b: "1948-06-15", insurance_type: "gkv", source: "everordnung" });
    const vo = (await f.asOrg(org, (c) => c.query("select diagnosis_group, urgent, home_visit, units from prescriptions where id = $1", [res.id]))).rows[0];
    expect(vo).toEqual({ diagnosis_group: "UI2", urgent: true, home_visit: true, units: 4 });
    await expect(evo.previewEverordnung(authFor(org, user, () => false), bundle("hmv-ui-minimal.json"))).rejects.toThrow(/Berechtigung/);
  });
  it("Neuanlage ist atomar: parallele Importe mit „neu anlegen“ hinterlassen genau eine Person und eine Verordnung", async () => {
    const org = await f.org();
    const user = await f.user();
    const auth = authFor(org, user);
    const results = await Promise.all([1, 2, 3].map(() => evo.importEverordnung(auth, bundle("hmv-ui-minimal.json"), { createPatient: true })));
    expect(results.filter((r) => "id" in r)).toHaveLength(1);
    const counts = (await f.asOrg(org, (c) => c.query("select (select count(*)::int from patients where organization_id = $1) as p, (select count(*)::int from prescriptions where organization_id = $1) as v", [org]))).rows[0];
    expect(counts).toEqual({ p: 1, v: 1 });
    // Fehler nach der Personenanlage (z. B. Dublette) → keine zusätzliche Person
    expect(await evo.importEverordnung(auth, bundle("hmv-ui-minimal.json"), { createPatient: true })).toEqual({ error: "Diese eVerordnung wurde bereits importiert." });
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int as n from patients where organization_id = $1", [org]))).rows[0].n).toBe(1);
  });

  it("Kandidatensuche: Nachname wird exakt (ohne LIKE-Platzhalter) verglichen", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { lastName: "Anders" });
    await f.asOrg(org, (c) => c.query("update patients set birth_date = '1948-06-15' where id = $1", [p]));
    const evil = bundle("hmv-ui-minimal.json").replace('"family": "Mustermann"', '"family": "%"').replace('"text": "Max Mustermann"', '"text": "Max %"');
    const pre = await evo.previewEverordnung(authFor(org, user), evil);
    if ("error" in pre) throw new Error(pre.error);
    expect(pre.candidates).toEqual([]);
    const ok = await evo.previewEverordnung(authFor(org, user), bundle("hmv-ui-minimal.json").replace(/Mustermann/g, "ANDERS"));
    expect("candidates" in ok && ok.candidates.map((c) => c.id)).toEqual([p]);
  });
});
