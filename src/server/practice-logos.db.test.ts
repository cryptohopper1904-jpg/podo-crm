/** Praxis-Logos, Belegdaten fürs PDF und E-Mail-Logo (echte DB, erfundene Daten). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PDFDocument } from "pdf-lib";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const PNG = readFileSync(path.join(__dirname, "../../docs/kunden/kiehne/logo-kiehne-zeichen.png"));
const PNG_FULL = readFileSync(path.join(__dirname, "../../docs/kunden/kiehne/logo-kiehne.png"));

(TEST_DB ? describe : describe.skip)("Praxis-Logos und Belege (DB)", () => {
  const f = fixtures(TEST_DB!);
  const files = new Map<string, Buffer>();
  let logos: typeof import("./practice-logos");
  let delivery: typeof import("./invoice-delivery");
  let invoices: typeof import("./invoices");
  let mail: typeof import("./mail");
  const authFor = (org: string, user: string, perms: string[] | "all" = "all") =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: (p: string) => perms === "all" || perms.includes(p) }) as never;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    const storage = await import("@/lib/storage");
    storage.setStorageDriver({ put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)!, remove: async (k) => void files.delete(k) });
    logos = await import("./practice-logos");
    delivery = await import("./invoice-delivery");
    invoices = await import("./invoices");
    mail = await import("./mail");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("speichert, ersetzt und entfernt Logos (verschlüsselt, mit Audit), nur mit settings.manage", async () => {
    const org = await f.org();
    const user = await f.user();
    const auth = authFor(org, user);
    await expect(logos.uploadLogo(authFor(org, user, ["patients.read"]), "compact", PNG)).rejects.toThrow(/Berechtigung/);

    await logos.uploadLogo(auth, "compact", PNG);
    const info = await logos.logoInfo(org);
    expect(info.compact).toMatchObject({ mime: "image/png", width: 223, height: 364, sizeBytes: PNG.length });
    expect(info.full).toBeUndefined();
    expect([...files.values()].some((b) => b.includes(PNG.subarray(100, 200)))).toBe(false); // verschlüsselt
    expect(Buffer.from((await logos.loadLogo(org, "compact"))!.bytes).equals(PNG)).toBe(true);
    // Rückfall: kein vollständiges Logo → Zeichen
    expect(await logos.loadLogo(org, "full")).toBeNull();
    expect((await logos.loadLogo(org, "full", { fallback: true }))!.width).toBe(223);

    // Ersetzen: alte Datei wird entfernt, nur eine Zeile je Art
    const before = files.size;
    await logos.uploadLogo(auth, "compact", PNG_FULL);
    expect(files.size).toBe(before);
    expect((await logos.logoInfo(org)).compact!.width).toBe(720);

    // Mandantentrennung
    const other = await f.org();
    expect(await logos.loadLogo(other, "compact", { fallback: true })).toBeNull();
    expect(await f.asOrg(other, async (c) => (await c.query("select count(*)::int n from organization_logos")).rows[0].n)).toBe(0);

    expect(await logos.removeLogo(auth, "compact")).toBe(true);
    expect(await logos.loadLogo(org, "compact")).toBeNull();
    expect(files.size).toBe(before - 1);
    const actions = await f.asOrg(org, async (c) => (await c.query("select action from audit_log where organization_id = $1 order by id", [org])).rows.map((r) => r.action));
    expect(actions.filter((a) => a.startsWith("settings.logo"))).toEqual(["settings.logo_upload", "settings.logo_upload", "settings.logo_remove"]);
  });

  it("lehnt falsche Dateien ab (Typ, Größe, kaputt) und die DB nur bekannte Arten", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    await expect(logos.uploadLogo(auth, "full", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).rejects.toThrow(/PNG- oder JPEG/);
    await expect(logos.uploadLogo(auth, "full", Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))).rejects.toThrow(/zu groß/);
    const broken = Buffer.from(PNG.subarray(0, 60));
    await expect(logos.uploadLogo(auth, "full", broken)).rejects.toThrow(/lässt sich nicht/);
    await expect(logos.uploadLogo(auth, "evil" as never, PNG)).rejects.toThrow(/Unbekannte/);
    await expect(
      f.asOrg(org, (c) => c.query("insert into organization_logos (organization_id, kind, storage_key, mime, size_bytes, sha256, width, height) values ($1,'banner','k','image/png',1,'x',1,1)", [org])),
    ).rejects.toThrow(/organization_logos_kind_check/);
    expect(await logos.logoInfo(org)).toEqual({});
  });

  it("Belegdaten fürs PDF: Leistungsdatum aus dem Termin, Logos, Buchungslink, Fußzeilenangaben; E-Mail mit Logo", async () => {
    process.env.PUBLIC_URL = "https://app.example.org";
    const org = await f.org({ settings: { websiteUrl: "https://www.example.org", documents: { qualification: "staatlich anerkannte Podologin", whatsapp: true, booking: { channel: "podohero" } } } });
    await f.pool.query("update organizations set iban = 'DE02120300000000202051', bic = 'BYLADEM1001', bank_name = 'Beispielbank', account_holder = 'Erika Muster' where id = $1", [org]);
    const user = await f.user();
    const auth = authFor(org, user);
    const patient = await f.patient(org);
    const appt = await f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,'2026-11-09 23:30+01','2026-11-10 00:10+01','done') returning id", [org, patient])).rows[0].id as string);
    const inv = await invoices.createInvoice(auth, {
      kind: "invoice",
      patientId: patient,
      billingContactId: null,
      issuedAt: "2026-11-13",
      dueDays: 14,
      therapeuticConfirmed: true,
      notes: null,
      payments: [],
      lines: [{ serviceId: null, appointmentId: appt, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0 }],
    } as never);
    await logos.uploadLogo(auth, "full", PNG_FULL);

    const bundle = await (await import("@/db")).withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, inv.id));
    expect(bundle!.serviceDates).toEqual(["2026-11-09"]); // Berliner Kalendertag
    const data = await delivery.invoicePdfData(bundle!);
    expect(data.organization).toMatchObject({ website: "https://www.example.org/", qualification: "staatlich anerkannte Podologin", whatsapp: true, bic: "BYLADEM1001", accountHolder: "Erika Muster" });
    expect(data.logos!.full!.mime).toBe("image/png");
    expect(data.logos!.compact).toBeNull();
    expect(data.booking).toEqual({ label: "Nächsten Termin online buchen:", url: `https://app.example.org/buchen/${bundle!.organization.slug}`, display: `app.example.org/buchen/${bundle!.organization.slug}` });
    const pdf = await delivery.invoicePdfForOrg(org, inv.id);
    expect((await PDFDocument.load(pdf!.bytes)).getPageCount()).toBe(1);

    const parts = await mail.brandedMailParts(org, "Guten Tag,\n\nIhr Termin morgen.");
    expect(parts!.html).toContain("cid:");
    expect(parts!.logo).toMatchObject({ contentType: "image/png", filename: "logo.png" });
    expect(await mail.brandedMailParts(await f.org(), "x")).toBeNull();
  });
});
