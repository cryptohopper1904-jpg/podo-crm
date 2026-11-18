/**
 * Praxis-Export gegen PostgreSQL: streamend, seitenweise, Medien einzeln.
 * Prüft Aufbau (README, tables/*.json, media/…) und dass nie mehr als eine Mediendatei gleichzeitig offen ist
 * und keine Datei als Ganzes geladen wird.
 */
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import JSZip from "jszip";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Praxis-Export (DB, Streaming)", () => {
  const f = fixtures(TEST_DB!);
  let exp: typeof import("./practice-export");
  let storage: typeof import("@/lib/storage");
  let lib: typeof import("@/lib/practice-export");

  // Speicher-Treiber im Arbeitsspeicher, der offene Streams zählt
  const files = new Map<string, Buffer>();
  const stats = { open: 0, peak: 0, opened: 0, wholeReads: 0 };
  const driver = {
    async put(key: string, data: Buffer) {
      files.set(key, data);
    },
    async get(key: string) {
      stats.wholeReads++;
      return files.get(key)!;
    },
    getStream(key: string) {
      const data = files.get(key);
      if (!data) throw new Error("fehlt");
      stats.open++;
      stats.opened++;
      stats.peak = Math.max(stats.peak, stats.open);
      const s = Readable.from(
        (function* () {
          for (let i = 0; i < data.length; i += 1024) yield data.subarray(i, i + 1024);
        })(),
        { objectMode: false },
      );
      s.once("close", () => stats.open--);
      return s;
    },
    async remove(key: string) {
      files.delete(key);
    },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    storage = await import("@/lib/storage");
    storage.setStorageDriver(driver);
    exp = await import("./practice-export");
    lib = await import("@/lib/practice-export");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  /** Liest den Web-Stream langsam (wie ein Download) und gibt das ZIP zurück. */
  async function drain(stream: ReadableStream<Uint8Array>) {
    const chunks: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      await new Promise((r) => setImmediate(r));
    }
    return Buffer.concat(chunks);
  }

  it("exportiert > N Medien und mehrere Tabellenseiten – Medien einzeln als Stream, Aufbau wie bisher", async () => {
    const org = await f.org();
    const owner = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, owner]);
    const PATIENTS = 23;
    const MEDIA = 30;
    const patientIds: string[] = [];
    for (let i = 0; i < PATIENTS; i++) patientIds.push(await f.patient(org, { lastName: `Muster${i}` }));
    const mediaIds: string[] = [];
    for (let i = 0; i < MEDIA; i++) {
      const content = Buffer.alloc(5_000 + i, i % 251);
      const stored = await storage.storeEncrypted(org, content);
      const id = await f.asOrg(org, async (c) =>
        (
          await c.query(
            "insert into media (organization_id, patient_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by) values ($1,$2,'photo','finding',$3,'image/jpeg',$4,$5,$6) returning id",
            [org, patientIds[i % PATIENTS], stored.storageKey, stored.sizeBytes, stored.sha256, owner],
          )
        ).rows[0].id as string,
      );
      mediaIds.push(id);
    }
    // eine manipulierte Datei: darf den Export nicht abbrechen
    const broken = mediaIds[7];
    const brokenKey = (await f.asOrg(org, (c) => c.query("select storage_key from media where id = $1", [broken]))).rows[0].storage_key as string;
    const tampered = Buffer.from(files.get(brokenKey)!);
    tampered[tampered.length - 1] ^= 0xff;
    files.set(brokenKey, tampered);

    await f.pool.query(`update organizations set settings = '{"ocr":{"provider":"openai","apiKeyEnc":"v1:GEHEIM-CHIFFRAT"},"reminderDays":2}'::jsonb where id = $1`, [org]);

    stats.peak = 0;
    stats.opened = 0;
    stats.wholeReads = 0;
    const result = await exp.buildPracticeExport({ organizationId: org, exportedBy: { name: "Inhaberin", email: "i@example.org" }, pageSize: 10, mediaPageSize: 7 });
    const zipBuf = await drain(result.stream);
    const summary = await result.done;

    expect(stats.peak).toBe(1); // nie mehr als eine Mediendatei gleichzeitig offen
    expect(stats.wholeReads).toBe(0); // keine Datei komplett in den Speicher geladen
    expect(stats.opened).toBeGreaterThanOrEqual(MEDIA); // Prüf- + Schreibdurchlauf je Datei
    expect(summary).toMatchObject({ mediaFiles: MEDIA - 1, mediaErrors: 1 });
    expect(summary.counts.patients).toBe(PATIENTS);
    expect(summary.counts.media).toBe(MEDIA);

    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);
    expect(names).toContain("README.txt");
    expect(names).toContain("tables/organizations.json");
    expect(names).toContain("tables/users.json");
    const orgText = await zip.file("tables/organizations.json")!.async("string");
    expect(orgText).not.toContain("GEHEIM-CHIFFRAT");
    expect(orgText).not.toContain("apiKeyEnc");
    expect(JSON.parse(orgText)[0].settings).toEqual({ ocr: { provider: "openai" }, reminderDays: 2 });
    for (const t of lib.tenantTables()) expect(names).toContain(`tables/${t.name}.json`);
    expect(names.filter((n) => n.startsWith("media/"))).toHaveLength(MEDIA - 1);

    const patientsText = await zip.file("tables/patients.json")!.async("string");
    // Format unverändert (wie toJson: eingerücktes JSON-Array)
    expect(patientsText).toBe(lib.toJson(JSON.parse(patientsText)));
    const patientsJson = JSON.parse(patientsText) as { id: string }[];
    expect(new Set(patientsJson.map((p) => p.id))).toEqual(new Set(patientIds));

    const mediaJson = JSON.parse(await zip.file("tables/media.json")!.async("string")) as Record<string, unknown>[];
    expect(mediaJson).toHaveLength(MEDIA);
    expect(mediaJson.every((m) => !("storageKey" in m))).toBe(true);
    const bad = mediaJson.find((m) => m.id === broken)!;
    expect(bad).toMatchObject({ exportFile: null, exportError: expect.any(String) });
    const good = mediaJson.find((m) => m.id === mediaIds[3])!;
    expect(names).toContain(good.exportFile);
    const extracted = await zip.file(good.exportFile as string)!.async("nodebuffer");
    expect(extracted.equals(Buffer.alloc(5_003, 3))).toBe(true);

    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toMatch(/patients\s+23/);
    expect(readme).toMatch(/Mediendateien\s+29/);
    expect(readme).toMatch(/ACHTUNG: 1 Datei/);
    // leere Tabelle bleibt ein gültiges JSON-Array
    expect(JSON.parse(await zip.file("tables/vouchers.json")!.async("string"))).toEqual([]);
  });

  it("Unterschriften (Leistungsnachweis) werden entschlüsselt mitexportiert (GKV Paket B R2-12)", async () => {
    const org = await f.org();
    const owner = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, owner]);
    const patient = await f.patient(org, { lastName: "Unterschrift" });
    const png = Buffer.from("PNG-Testinhalt");
    const stored = await storage.storeEncrypted(org, png);
    const sigId = await f.asOrg(org, async (c) => {
      const vo = (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,'2026-11-02','DF',6) returning id", [org, patient])).rows[0].id;
      const rec = (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prescription_id, hash) values ($1,$2,$3,now(),$4,'h') returning id", [org, patient, owner, vo])).rows[0].id;
      return (
        await c.query(
          "insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, signer_name, signer_role, storage_key, mime, size_bytes, sha256, created_by) values ($1,$2,$3,$4,'device','Erika Muster','insured',$5,'image/png',$6,$7,$8) returning id",
          [org, rec, patient, vo, stored.storageKey, stored.sizeBytes, stored.sha256, owner],
        )
      ).rows[0].id as string;
    });
    const result = await exp.buildPracticeExport({ organizationId: org, exportedBy: { name: "Inhaberin", email: "i@example.org" } });
    const zip = await JSZip.loadAsync(await drain(result.stream));
    await result.done;
    const rows = JSON.parse(await zip.file("tables/treatment_signatures.json")!.async("string")) as Record<string, unknown>[];
    const row = rows.find((r) => r.id === sigId)!;
    expect(row).not.toHaveProperty("storageKey");
    expect(row.exportFile).toMatch(/^unterschriften\/\d+\/.+\.png$/);
    expect((await zip.file(row.exportFile as string)!.async("nodebuffer")).equals(png)).toBe(true);
  });

  it("Abbruch des Downloads beendet die Erzeugung (done wird abgelehnt)", async () => {
    const org = await f.org();
    const owner = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, owner]);
    const p = await f.patient(org);
    for (let i = 0; i < 5; i++) {
      const stored = await storage.storeEncrypted(org, Buffer.alloc(200_000, i));
      await f.asOrg(org, (c) =>
        c.query(
          "insert into media (organization_id, patient_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by) values ($1,$2,'photo','finding',$3,'image/jpeg',$4,$5,$6)",
          [org, p, stored.storageKey, stored.sizeBytes, stored.sha256, owner],
        ),
      );
    }
    const result = await exp.buildPracticeExport({ organizationId: org, exportedBy: { name: "I", email: "i@example.org" } });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.cancel();
    await expect(result.done).rejects.toThrow();
  });
});
