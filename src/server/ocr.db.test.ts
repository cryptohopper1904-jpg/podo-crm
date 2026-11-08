/**
 * Verordnungs-OCR gegen eine echte DB (RLS aktiv, erfundene Daten, Testmodus-Adapter):
 * Standard aus → Auslesen im Testmodus → Übernehmen speichert source „ocr“ + importData (ohne Bild),
 * Rate-Limit je Praxis, Einstellungen nur durch die Inhaber:in, Audit ohne Gesundheitsdaten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5]);

(TEST_DB ? describe : describe.skip)("Verordnungs-OCR (DB)", () => {
  const f = fixtures(TEST_DB!);
  let ocr: typeof import("./ocr");
  let rx: typeof import("./prescriptions");
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.INTEGRATIONS_MODE;
    const storage = await import("@/lib/storage");
    storage.setStorageDriver({ put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)!, remove: async (k) => void files.delete(k) });
    ocr = await import("./ocr");
    rx = await import("./prescriptions");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authFor = (org: string, user: string, role = "owner") => ({ organization: { id: org, name: "T" }, user: { id: user, name: "Test" }, role, support: null, can: () => true }) as never;

  async function setup(settings: Record<string, unknown> = {}, bytes: Buffer = JPEG) {
    const org = await f.org({ settings });
    const user = await f.user();
    const patientId = await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    const { storeEncrypted } = await import("@/lib/storage");
    const stored = await storeEncrypted(org, bytes);
    const mediaId = await f.asOrg(org, async (c) =>
      (
        await c.query(
          "insert into media (organization_id, patient_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by) values ($1,$2,'photo','prescription',$3,'image/jpeg',$4,$5,$6) returning id",
          [org, patientId, stored.storageKey, stored.sizeBytes, stored.sha256, user],
        )
      ).rows[0].id as string,
    );
    return { org, user, patientId, mediaId, auth: authFor(org, user) };
  }

  it("ist standardmäßig aus", async () => {
    const { auth, patientId, mediaId } = await setup();
    expect(await ocr.extractPrescriptionFromMedia(auth, { patientId, mediaId })).toEqual({ error: expect.stringMatching(/ausgeschaltet/) });
  });

  it("Testmodus: Vorschlag → Übernehmen speichert source „ocr“ und importData ohne Bild; Audit ohne PHI", async () => {
    const { org, auth, patientId, mediaId } = await setup({ ocr: { enabled: true, mode: "mock" } });
    const res = await ocr.extractPrescriptionFromMedia(auth, { patientId, mediaId });
    if ("error" in res) throw new Error(res.error);
    expect(res.mock).toBe(true);
    const s = res.suggestion.fields;
    expect(s.diagnosisGroup?.value).toBe("DF");

    // Noch nichts gespeichert
    const before = await f.asOrg(org, (c) => c.query("select count(*)::int n from prescriptions where patient_id = $1", [patientId]));
    expect(before.rows[0].n).toBe(0);

    const importData = JSON.stringify({ kind: "ocr", mock: true, at: new Date().toISOString(), fields: s, edited: ["units"] });
    const input = rx.prescriptionInput.parse({
      patientId,
      issuedAt: s.issuedAt!.value,
      diagnosisGroup: "DF",
      icd10: s.icd10!.value,
      units: "5",
      doctorLanr: s.doctorLanr!.value,
      doctorBsnr: s.doctorBsnr!.value,
      positions: JSON.stringify(s.positions!.value),
      scanMediaId: mediaId,
      source: "ocr",
      importData,
    });
    const saved = await rx.savePrescription(auth, input);
    if ("error" in saved) throw new Error(saved.error);
    const row = (await f.asOrg(org, (c) => c.query("select source, import_data, units, scan_media_id from prescriptions where id = $1", [saved.id]))).rows[0];
    expect(row.source).toBe("ocr");
    expect(row.units).toBe(5);
    expect(row.scan_media_id).toBe(mediaId);
    expect(row.import_data.kind).toBe("ocr");
    expect(row.import_data.edited).toEqual(["units"]);
    expect(row.import_data.fields.units.value).toBe(6); // Vorschlag bleibt nachvollziehbar
    expect(JSON.stringify(row.import_data)).not.toMatch(/base64|data:image/);

    const logs = (await f.pool.query("select action, meta from audit_log where organization_id = $1 and action = 'prescription.ocr'", [org]).catch(() => ({ rows: [] as { meta: unknown }[] }))).rows;
    for (const l of logs) expect(JSON.stringify(l.meta)).not.toMatch(/Musterfrau|E11|X000000001/);
  });

  it("source „ocr“ ohne gültige importData wird abgelehnt", async () => {
    const { auth, patientId, mediaId } = await setup({ ocr: { enabled: true, mode: "mock" } });
    const input = rx.prescriptionInput.parse({ patientId, issuedAt: new Date().toISOString().slice(0, 10), diagnosisGroup: "DF", units: "6", positions: "[]", scanMediaId: mediaId, source: "ocr", importData: "{kaputt" });
    expect(await rx.savePrescription(auth, input)).toEqual({ error: expect.stringMatching(/ungültig/) });
  });

  it("nur Fotos (kein PDF) und nur Fotos der eigenen Person", async () => {
    const pdf = await setup({ ocr: { enabled: true, mode: "mock" } }, Buffer.from("%PDF-1.4 test"));
    expect(await ocr.extractPrescriptionFromMedia(pdf.auth, { patientId: pdf.patientId, mediaId: pdf.mediaId })).toEqual({ error: expect.stringMatching(/nur mit Fotos/) });
    const other = await f.patient(pdf.org, { lastName: "Beispiel" });
    expect(await ocr.extractPrescriptionFromMedia(pdf.auth, { patientId: other, mediaId: pdf.mediaId })).toEqual({ error: expect.stringMatching(/nicht gefunden/) });
  });

  it("Rate-Limit je Praxis (Stundenquote aus den Einstellungen)", async () => {
    const { auth, patientId, mediaId } = await setup({ ocr: { enabled: true, mode: "mock", perHour: 2 } });
    expect("suggestion" in (await ocr.extractPrescriptionFromMedia(auth, { patientId, mediaId }))).toBe(true);
    expect("suggestion" in (await ocr.extractPrescriptionFromMedia(auth, { patientId, mediaId }))).toBe(true);
    expect(await ocr.extractPrescriptionFromMedia(auth, { patientId, mediaId })).toEqual({ error: expect.stringMatching(/Zu viele/) });
  });

  it("Einstellungen: nur Inhaber:in; echter Dienst nur mit Bestätigung", async () => {
    const { org, user } = await setup();
    const base = { enabled: true, mode: "live" as const, baseUrl: "https://api.mistral.ai/v1", model: "pixtral-large-latest", imageStyle: "string" as const, apiKey: "test-key", perHour: 30 };
    const none = { avv: false, subprocessor: false, dataLeavesPractice: false };
    expect(await ocr.saveOcrSettings(authFor(org, user, "therapist"), { ...base, confirm: none })).toEqual({ error: expect.stringMatching(/Inhaber/) });
    // Adresse wird per DNS geprüft – ohne Netz kann das scheitern; dann reicht die Ablehnung als Nachweis
    const noConsent = await ocr.saveOcrSettings(authFor(org, user), { ...base, confirm: none });
    expect("error" in noConsent).toBe(true);
    const mockOnly = await ocr.saveOcrSettings(authFor(org, user), { ...base, mode: "mock", baseUrl: undefined, apiKey: undefined, confirm: none });
    expect(mockOnly).toEqual({ ok: expect.stringMatching(/Testmodus/) });
    const s = await ocr.loadOcrSettings(org);
    expect(s).toMatchObject({ enabled: true, mode: "mock" });
    expect(s.consent).toBeUndefined();
  });
});
