/**
 * Direktabrechnung § 302 (Paket D) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten, IKs „99…“):
 * Kostenträgerdatei hochladen/ersetzen/prüfen, Prüflauf, Testpaket mit Nummernkreis unter Zeilensperre, Mandantentrennung
 * und Rechte.
 *
 * Das Kennzeichen Verordnungsart steht seit GKV Paket C bestätigt an der Verordnung (`prescription_kind`); die meisten
 * Fälle hier legen es nicht an (Bestand) und schalten es für den Erfolgsweg über eine Hülle um
 * `erzeugeTestpaket`/`pruefeFaelle` ein – nur hier im Test. Der Paket-C-Fall prüft den Weg aus der Datenbank ohne Hülle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const schalter = vi.hoisted(() => ({ verordnungsart: null as string | null }));
vi.mock("@/lib/gkv302/direktabrechnung", async (orig) => {
  const m = await orig<typeof import("@/lib/gkv302/direktabrechnung")>();
  const mit = (vos: import("@/lib/gkv302/direktabrechnung").DaVerordnung[]) => vos.map((v) => ({ ...v, verordnungsart: (schalter.verordnungsart ?? v.verordnungsart) as never }));
  return {
    ...m,
    pruefeFaelle: (p: never, vos: never, k: never, s: string) => m.pruefeFaelle(p, mit(vos), k, s),
    erzeugeTestpaket: (p: never, vos: never, k: never, j: never, n: never) => m.erzeugeTestpaket(p, mit(vos), k, j, n),
  };
});
const pdfSchalter = vi.hoisted(() => ({ fehler: false }));
vi.mock("@/lib/gkv302/begleitzettel-pdf", async (orig) => {
  const m = await orig<typeof import("@/lib/gkv302/begleitzettel-pdf")>();
  return { begleitzettelPdf: async (...a: Parameters<typeof m.begleitzettelPdf>) => {
    if (pdfSchalter.fehler) throw new Error("PDF kaputt (Test)");
    return m.begleitzettelPdf(...a);
  } };
});
import { audit } from "@/lib/audit";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const KOTR = readFileSync(path.join(__dirname, "../lib/gkv302/fixtures/kotr-test.ke0"));
const KASSE = "990020015";
const PRAXIS_IK = "990010013";

(TEST_DB ? describe : describe.skip)("Direktabrechnung § 302 (DB)", () => {
  const f = fixtures(TEST_DB ?? "");
  const files = new Map<string, Buffer>();
  let x: typeof import("./gkv302-export");
  let org: string, org2: string, user: string;
  const authFor = (o: string, perms: string[] | "all" = "all", support: unknown = null) =>
    ({ organization: { id: o, name: "Testpraxis Fuß", slug: "t", smallBusiness: false, state: "BE", billingMode: "with_gkv" }, user: { id: user, name: "Test" }, role: "owner", readOnly: false, support, can: (p: string) => perms === "all" || perms.includes(p) }) as never;
  const JETZT = { datum: "2026-11-18", uhrzeit: "10:15", sekunde: "30" };

  const snapshot = {
    rulesVersion: "test", computedOn: "2026-10-20", remedyCents: 7110, copaymentPercentCents: 712, flatFeeCents: 1000, copaymentCents: 1712, complete: true, notes: [],
    lines: [
      { date: "2026-10-05", position: "78020", units: 1, priceCents: 3555, copayCents: 356, minor: false, exempt: false, tableVersion: "test" },
      { date: "2026-10-19", position: "78020", units: 1, priceCents: 3555, copayCents: 356, minor: false, exempt: false, tableVersion: "test" },
    ],
  };
  const verordnung = async (o: string, opts: { status?: string; batch?: string | null; lastName?: string; kind?: string; approval?: boolean } = {}) => {
    const p = await f.patient(o, { lastName: opts.lastName ?? "Testfall", firstName: "Erika" });
    await f.asOrg(o, (c) => c.query("update patients set birth_date = '1950-04-12', street = 'Musterweg 2', zip = '10115', city = 'Berlin' where id = $1", [p]));
    return f.asOrg(o, async (c) =>
      (
        await c.query(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, positions, icd10, insurer_ik, insurance_number, insured_status,
             doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, price_snapshot, remedy_cost_cents, copayment_cents, billing_batch_id,
             prescription_kind, prescription_kind_confirmed_at, prescription_special, approval_ref, approval_date)
           values ($1,$2,'2026-10-01','DF',2,$3,$4,'E11.74',$5,'X000000001','1','999000101','999000001',true,'a',$6,7110,1712,$7,
             $8, case when $8::text is null then null else now() end, $9, $10, $11) returning id`,
          [
            o,
            p,
            opts.status ?? "billing_ready",
            JSON.stringify([{ position: "78020", label: "groß", units: 2 }]),
            KASSE,
            JSON.stringify(snapshot),
            opts.batch ?? null,
            opts.kind ?? null,
            opts.approval ? "4" : null,
            opts.approval ? "G-2026/17" : null,
            opts.approval ? "2026-09-01" : null,
          ],
        )
      ).rows[0].id as string,
    );
  };
  const zaehler = async (o: string) => (await f.pool.query("select settings->'gkv302Zaehler' as z from organizations where id = $1", [o])).rows[0].z;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const storage = await import("@/lib/storage");
    storage.setStorageDriver({ put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)!, remove: async (k) => void files.delete(k) });
    x = await import("./gkv302-export");
    org = await f.org({ settings: { keep: 1 } });
    org2 = await f.org();
    user = await f.user(org);
    for (const o of [org, org2]) {
      await f.pool.query("update organizations set ik = $2, legs_code = '7100501', street = 'Teststraße 1', zip = '10115', city = 'Berlin', email = 'abrechnung@example.org' where id = $1", [o, PRAXIS_IK]);
    }
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Kostenträgerdatei: prüfen, verschlüsselt ablegen, gleiche Kassenart ersetzen, entfernen", async () => {
    await expect(x.kotrHochladen(authFor(org), "x.ke0", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).rejects.toThrow(/Binärdaten/);
    await expect(x.kotrHochladen(authFor(org), "x.ke0", Buffer.from("UNB+UNOC:3'"))).rejects.toThrow(/nicht lesbar/);
    await expect(x.kotrHochladen(authFor(org), "x.ke0", Buffer.alloc(x.KOTR_MAX_BYTES + 1, 0x41))).rejects.toThrow(/zu groß/);
    await expect(x.kotrHochladen(authFor(org, ["invoices.write"]), "GK05Q426.KE0", KOTR)).rejects.toThrow(/settings.manage/);
    const e1 = await x.kotrHochladen(authFor(org), "kotr-test.ke0", KOTR);
    expect(e1).toEqual(expect.objectContaining({ kassenart: "GK", dateiname: "GK05Q426.KE0", gueltigAb: "Q4/2026", gueltigAbDatum: "2026-10-01", institutionen: 8 }));
    // verschlüsselt: in der Ablage steht nicht der Klartext
    expect(files.get(e1.storageKey)!.includes(Buffer.from("Testkasse"))).toBe(false);
    const e2 = await x.kotrHochladen(authFor(org), "GK05Q426.KE0", KOTR);
    expect(files.has(e1.storageKey)).toBe(false);
    const s = await x.gkv302Status(org);
    expect(s.kotr.map((k) => k.storageKey)).toEqual([e2.storageKey]);
    expect(s.krypto.zertifikat).toBe("nicht_hinterlegt");
    // andere Einstellungen bleiben erhalten (jsonb_set auf den eigenen Pfad)
    expect((await f.pool.query("select settings->'keep' as k from organizations where id = $1", [org])).rows[0].k).toBe(1);
    expect(await x.kotrEntfernen(authFor(org), "GK")).toBe(true);
    expect(files.has(e2.storageKey)).toBe(false);
    expect((await x.gkv302Status(org)).kotr).toEqual([]);
  });

  it("Tarifkennzeichen wird geprüft und gespeichert", async () => {
    await expect(x.saveTarifkennzeichen(authFor(org), "1")).rejects.toThrow(/ungültig/);
    await x.saveTarifkennzeichen(authFor(org), " 50000 ");
    await x.saveTarifkennzeichen(authFor(org2), "50000");
    expect((await x.gkv302Status(org)).tarifkennzeichen).toBe("50000");
  });

  it("Prüflauf ohne Kostenträgerdatei und ohne Verordnungsart: Hinweis, fehlende Angabe, keine Datei, Zähler unverändert", async () => {
    await verordnung(org);
    schalter.verordnungsart = null;
    const e = await x.pruefe302(authFor(org), { art: "bereit" }, JETZT);
    if ("error" in e) throw new Error(e.error);
    expect(e.kotrVorhanden).toBe(false);
    expect(e.faelle).toHaveLength(1);
    expect(e.faelle[0].status).toBe("fehlend");
    expect(e.faelle[0].fehlendeAngaben.join(" ")).toContain("Verordnungsart");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "gkv302.pruefen", meta: expect.objectContaining({ faelle: 1, ok: 0 }) }));
    // Audit ohne Patientendaten
    expect(JSON.stringify(vi.mocked(audit).mock.calls.at(-1))).not.toContain("Testfall");
    await x.kotrHochladen(authFor(org), "GK05Q426.KE0", KOTR);
    const r = await x.testpaket302(authFor(org), { art: "bereit" }, JETZT);
    expect(r).toEqual({ error: expect.stringContaining("Kein Fall ist vollständig") });
    expect(await zaehler(org)).toBeNull();
  });

  it("Testpaket: nur Fälle „ok“, Nummern fortlaufend auch bei gleichzeitigen Anfragen, Audit in der Transaktion", async () => {
    schalter.verordnungsart = "03";
    await verordnung(org, { lastName: "Beispiel" });
    const [a, b] = await Promise.all([x.testpaket302(authFor(org), { art: "bereit" }, JETZT), x.testpaket302(authFor(org), { art: "bereit" }, JETZT)]);
    if ("error" in a || "error" in b) throw new Error("Testpaket fehlgeschlagen");
    const nummern = [];
    for (const r of [a, b]) {
      const zip = await JSZip.loadAsync(r.zip);
      const namen = Object.keys(zip.files);
      expect(namen).toContain("LIESMICH_TEST_NICHT_VERSENDEN.txt");
      expect(namen).toContain("Begleitzettel_TEST.pdf");
      const nutz = namen.find((n) => /\/TSOL0\d{3}$/.test(n))!;
      const text = Buffer.from(await zip.file(nutz)!.async("uint8array")).toString("latin1");
      nummern.push(/T2026-\d{5}/.exec(text)![0]);
      expect(r.dateiname).toMatch(/^TEST-302-2026-11-18-TSOL0\d{3}\.zip$/);
    }
    expect(nummern.sort()).toEqual(["T2026-00001", "T2026-00002"]);
    expect(await zaehler(org)).toEqual({ test: { rechnung: { "2026": 2 }, transfer: 1, dar: { "990030017": 2 } } });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "gkv302.testdatei", meta: expect.objectContaining({ quelle: "bereit" }) }), expect.anything());
  });

  it("Abrechnungslauf: nur eigener Lauf; fremde Praxis sieht nichts (RLS + Filter)", async () => {
    const batch = (await f.asOrg(org, (c) => c.query("insert into billing_batches (organization_id, prescription_count) values ($1, 1) returning id", [org]))).rows[0].id as string;
    await verordnung(org, { status: "billed", batch });
    const e = await x.pruefe302(authFor(org), { art: "lauf", batchId: batch }, JETZT);
    if ("error" in e) throw new Error(e.error);
    expect(e.faelle).toHaveLength(1);
    expect(await x.pruefe302(authFor(org2), { art: "lauf", batchId: batch }, JETZT)).toEqual({ error: "Abrechnungslauf nicht gefunden." });
    expect(await x.testpaket302(authFor(org2), { art: "lauf", batchId: batch }, JETZT)).toEqual({ error: "Abrechnungslauf nicht gefunden." });
    const fremd = await x.pruefe302(authFor(org2), { art: "bereit" }, JETZT);
    if ("error" in fremd) throw new Error(fremd.error);
    expect(fremd.faelle).toEqual([]);
  });

  it("Rechte: invoices.write und medical.read nötig; Praxis ohne Kassenabrechnung gesperrt", async () => {
    await expect(x.pruefe302(authFor(org, ["invoices.write"]), { art: "bereit" }, JETZT)).rejects.toThrow(/medical.read/);
    await expect(x.testpaket302(authFor(org, ["medical.read"]), { art: "bereit" }, JETZT)).rejects.toThrow(/invoices.write/);
    const privat = { ...(authFor(org) as object), organization: { id: org, name: "T", slug: "t", smallBusiness: false, state: "BE", billingMode: "private_only" } } as never;
    expect(await x.testpaket302(privat, { art: "bereit" }, JETZT)).toEqual({ error: expect.any(String) });
  });

  describe("Review-Runde 2", () => {
    it("Support (auch mit Schreibrecht) darf keine Kostenträgerdateien hochladen oder entfernen", async () => {
      const sup = authFor(org, "all", { grantId: "g", scope: "write", expiresAt: new Date(Date.now() + 60_000) });
      await expect(x.kotrHochladen(sup, "GK05Q426.KE0", KOTR)).rejects.toThrow(/Support/);
      await expect(x.kotrEntfernen(sup, "GK")).rejects.toThrow(/Support/);
    });

    it("Uploads je Praxis gedrosselt", async () => {
      const o = await f.org();
      for (let i = 0; i < x.KOTR_UPLOADS_JE_FENSTER; i++) await x.kotrHochladen(authFor(o), "GK05Q426.KE0", KOTR);
      await expect(x.kotrHochladen(authFor(o), "GK05Q426.KE0", KOTR)).rejects.toThrow(/Zu viele Uploads/);
    });

    it("fremder Speicherschlüssel in settings wird weder gelesen noch gelöscht", async () => {
      const o = await f.org();
      const fremd = `${org2}/2026/11/00000000-0000-4000-8000-000000000001.bin`;
      files.set(fremd, Buffer.from("fremd"));
      const eintrag = { kassenart: "GK", dateiname: "GK05Q426.KE0", storageKey: fremd, sha256: "x", sizeBytes: 5, gueltigAb: "Q4/2026", gueltigAbDatum: "2026-10-01", erstellt: "", institutionen: 1, hochgeladenAm: new Date().toISOString() };
      await f.pool.query("update organizations set ik = $2, legs_code = '7100501', street = 'S 1', zip = '10115', city = 'Berlin', settings = $3 where id = $1", [o, PRAXIS_IK, JSON.stringify({ gkv302: { tarifkennzeichen: "50000", kotr: [eintrag] } })]);
      const e = await x.pruefe302(authFor(o), { art: "bereit" }, JETZT);
      if ("error" in e) throw new Error(e.error);
      expect(e.kotrVorhanden).toBe(false);
      expect(e.kotrHinweise.join(" ")).toContain("GK05Q426.KE0 ist nicht lesbar");
      expect(await x.kotrEntfernen(authFor(o), "GK")).toBe(true);
      expect(files.has(fremd)).toBe(true);
    });

    it("ohne Organisation: Fehlermeldung statt Absturz", async () => {
      expect(await x.pruefe302(authFor("00000000-0000-4000-8000-0000000000ff"), { art: "bereit" }, JETZT)).toEqual({ error: "Praxis nicht gefunden." });
    });

    it("scheitert das Begleitzettel-PDF, werden keine Nummern verbraucht", async () => {
      schalter.verordnungsart = "03";
      const vorher = await zaehler(org);
      pdfSchalter.fehler = true;
      try {
        await expect(x.testpaket302(authFor(org), { art: "bereit" }, JETZT)).rejects.toThrow(/PDF kaputt/);
      } finally {
        pdfSchalter.fehler = false;
      }
      expect(await zaehler(org)).toEqual(vorher);
    });

    it("8 gleichzeitige Testpakete: eindeutige, lückenlose Rechnungs- und Transfernummern", async () => {
      schalter.verordnungsart = "03";
      const o = await f.org();
      await f.pool.query("update organizations set ik = $2, legs_code = '7100501', street = 'S 1', zip = '10115', city = 'Berlin' where id = $1", [o, PRAXIS_IK]);
      await x.saveTarifkennzeichen(authFor(o), "50000");
      await x.kotrHochladen(authFor(o), "GK05Q426.KE0", KOTR);
      await verordnung(o);
      const r = await Promise.all(Array.from({ length: 8 }, () => x.testpaket302(authFor(o), { art: "bereit" }, JETZT)));
      const nummern: string[] = [];
      const transfer: string[] = [];
      for (const z of r) {
        if ("error" in z) throw new Error(z.error);
        const zip = await JSZip.loadAsync(z.zip);
        const nutz = Object.keys(zip.files).find((n) => /\/TSOL0\d{3}$/.test(n))!;
        transfer.push(nutz.slice(-3));
        nummern.push(/T2026-\d{5}/.exec(Buffer.from(await zip.file(nutz)!.async("uint8array")).toString("latin1"))![0]);
      }
      expect(nummern.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `T2026-0000${i + 1}`));
      expect(transfer.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `00${i}`));
      expect(await zaehler(o)).toEqual({ test: { rechnung: { "2026": 8 }, transfer: 7, dar: { "990030017": 8 } } });
    });
  });

  it("Paket C: bestätigtes Kennzeichen, Besonderheit und Genehmigung kommen aus der Verordnung (ohne Hülle); ohne Kennzeichen fehlend", async () => {
    const o = await f.org();
    await f.pool.query("update organizations set ik = $2, legs_code = '7100501', street = 'Teststraße 1', zip = '10115', city = 'Berlin', email = 'abrechnung@example.org' where id = $1", [o, PRAXIS_IK]);
    schalter.verordnungsart = null;
    await x.saveTarifkennzeichen(authFor(o), "50000");
    await x.kotrHochladen(authFor(o), "GK05Q426.KE0", KOTR);
    await verordnung(o, { lastName: "Ohne" });
    await verordnung(o, { lastName: "Mit", kind: "04", approval: true });
    const e = await x.pruefe302(authFor(o), { art: "bereit" }, JETZT);
    if ("error" in e) throw new Error(e.error);
    const ohne = e.faelle.find((c) => c.anzeige.includes("Ohne"))!;
    const mit = e.faelle.find((c) => c.anzeige.includes("Mit"))!;
    expect(ohne.fehlendeAngaben.join(" ")).toContain("Verordnungsart");
    expect(mit.status).toBe("ok");
    const r = await x.testpaket302(authFor(o), { art: "bereit" }, JETZT);
    if ("error" in r) throw new Error(r.error);
    const zip = await JSZip.loadAsync(r.zip);
    const nutz = Object.keys(zip.files).find((n) => /\/TSOL0\d{3}$/.test(n))!;
    const text = Buffer.from(await zip.file(nutz)!.async("uint8array")).toString("latin1");
    expect(text).toContain("SKZ+G-2026/17+20260901+B2'");
    expect(text).toMatch(/ZHE\+[^']*\+04\+4\+/);
    // nie still „03“: der Fall ohne Kennzeichen ist nicht in der Datei
    expect(text).not.toContain("Ohne");
  });
});
