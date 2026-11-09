/**
 * Gesamt-Review H3: „Kund:in löschen“ gegen eine echte DB (RLS, Append-only-Trigger aktiv, erfundene Daten).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";
import type { AuthContext } from "@/lib/auth/session";

(TEST_DB ? describe : describe.skip)("Kund:in löschen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let del: typeof import("./patient-deletion");
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const storage = await import("@/lib/storage");
    storage.setStorageDriver({ put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)!, remove: async (k) => void files.delete(k) });
    del = await import("./patient-deletion");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const ownerAuth = (org: string, user: string, o: Partial<AuthContext> = {}) =>
    ({ role: "owner", support: null, organization: { id: org }, user: { id: user }, can: () => true, ...o }) as unknown as AuthContext;
  const addMedia = (org: string, patient: string, user: string, purpose: string, key: string, recordId: string | null = null) =>
    f.asOrg(org, (c) =>
      c.query(
        "insert into media (organization_id, patient_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by, record_id) values ($1,$2,'photo',$3,$4,'image/jpeg',3,'x',$5,$6)",
        [org, patient, purpose, key, user, recordId],
      ),
    );
  const exists = async (org: string, p: string) => (await f.asOrg(org, (c) => c.query("select 1 from patients where id = $1", [p]))).rowCount === 1;

  it("ohne Dokumentation/Rechnungen: vollständige Löschung inkl. Einwilligungen und Fotos, Audit ohne Namen", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { lastName: "Löschbar" });
    await f.consent(org, p, "marketing", true);
    const key = `${org}/m-${Date.now()}`;
    files.set(key, Buffer.from("abc"));
    await addMedia(org, p, user, "marketing", key);
    expect((await del.deletionStatus(ownerAuth(org, user), p))?.mode).toBe("delete");
    await del.deletePatient(ownerAuth(org, user), p);
    expect(await exists(org, p)).toBe(false);
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int n from consents where patient_id = $1", [p]))).rows[0].n).toBe(0);
    expect(files.has(key)).toBe(false);
    const a = await f.asOrg(org, (c) => c.query("select meta from audit_log where action = 'patient.deleted' and entity_id = $1", [p]));
    expect(a.rowCount).toBe(1);
    expect(JSON.stringify(a.rows[0].meta)).not.toContain("Löschbar");
  });

  it("mit Behandlung: Löschung gesperrt (auch direkt in der DB), Kontaktdaten werden gelöscht und Marketing widerrufen", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { lastName: "Akte", email: "akte@example.org", phoneMobile: "0151 1" });
    await f.asOrg(org, (c) =>
      c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prev_hash, hash) values ($1,$2,$3, now(), null, 'h')", [org, p, user]),
    );
    await f.consent(org, p, "marketing", true);
    await f.consent(org, p, "photo_documentation", true);
    const key = `${org}/mk-${Date.now()}`;
    files.set(key, Buffer.from("abc"));
    await addMedia(org, p, user, "marketing", key);

    const st = await del.deletionStatus(ownerAuth(org, user), p);
    expect(st?.mode).toBe("anonymize");
    await expect(del.deletePatient(ownerAuth(org, user), p)).rejects.toThrow(/aufbewahrungspflichtig/);
    await expect(f.asOrg(org, (c) => c.query("select podo_delete_patient($1)", [p]))).rejects.toThrow(/Aufbewahrungspflichtige/);

    const r = await del.erasePatientContact(ownerAuth(org, user), p);
    expect(r).toEqual({ revoked: 1, photos: 1 });
    const row = (await f.asOrg(org, (c) => c.query("select email, phone_mobile, archived_at, contact_erased_at, last_name from patients where id = $1", [p]))).rows[0];
    expect(row).toMatchObject({ email: null, phone_mobile: null, last_name: "Akte" });
    expect(row.archived_at).not.toBeNull();
    expect(row.contact_erased_at).not.toBeNull();
    const latest = (await f.asOrg(org, (c) => c.query("select granted from consents where patient_id = $1 and type = 'marketing' order by recorded_at desc limit 1", [p]))).rows[0];
    expect(latest.granted).toBe(false);
    // Einwilligung zur Fotodokumentation (Behandlung) bleibt unberührt
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int n from consents where patient_id = $1 and type = 'photo_documentation'", [p]))).rows[0].n).toBe(1);
    expect(files.has(key)).toBe(false);
  });

  it("App-Rolle kann das Lösch-Kennzeichen nicht missbrauchen (Append-only bleibt)", async () => {
    const org = await f.org();
    const p = await f.patient(org);
    await f.consent(org, p, "marketing", true);
    await expect(
      f.asOrg(org, async (c) => {
        await c.query("select set_config('podo.patient_delete', $1, true)", [p]);
        await c.query("delete from consents where patient_id = $1", [p]);
      }),
    ).rejects.toThrow(/unveränderbar/);
  });

  it("mit Rechnung: Sperre; nur Inhaber:in und nie im Support-Modus", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org);
    await f.invoice(org, p);
    expect((await del.deletionStatus(ownerAuth(org, user), p))?.mode).toBe("anonymize");
    await expect(del.deletePatient(ownerAuth(org, user, { role: "reception" } as Partial<AuthContext>), p)).rejects.toThrow(/Inhaber/);
    await expect(del.erasePatientContact(ownerAuth(org, user, { support: { grantId: "g", scope: "write", expiresAt: new Date() } }), p)).rejects.toThrow(/Inhaber/);
  });
});
