/**
 * Beleg-Archiv (GoBD, § 14b UStG), Zahlungsbelege nach Ausstellung (§ 146a Abs. 2 AO, § 6 KassenSichV) und
 * Storno-Neudruck mit festgeschriebener Anrechnung (§ 14 Abs. 5 S. 2 UStG). Echte DB, erfundene Daten.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFPage } from "pdf-lib";
import { Pool } from "pg";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrlFrom = (url: string) => url.replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
const MIGRATION = readFileSync(path.join(__dirname, "../../drizzle/0049_beleg_archiv.sql"), "utf8");

let drawn: string[] = [];
beforeEach(() => {
  drawn = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
    drawn.push(text);
    return orig.call(this, text, options);
  });
});
afterEach(() => vi.restoreAllMocks());

(TEST_DB ? describe : describe.skip)("Beleg-Archiv, Zahlungsbelege, Storno-Neudruck (DB)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 1 });
  let invoices: typeof import("./invoices");
  let delivery: typeof import("./invoice-delivery");
  let receipts: typeof import("./payment-receipts");
  let webhooks: typeof import("./webhooks");
  let withOrg: typeof import("@/db").withOrg;
  let today: string;
  /** Ablage wie LocalDriver (Dateien unter STORAGE_DIR), aber mit schaltbarem Schreibfehler */
  let failPut = false;
  const authFor = (org: string, user: string) =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;
  const line = { serviceId: null, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0 };
  const base = (patientId: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "invoice", patientId, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], lines: [line], ...patch }) as never;
  const pay = (method: string, amountCents: number) => ({ method, amountCents, voucherCode: null, externalRef: null }) as never;
  const bundle = (org: string, id: string) => withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, id)).then((b) => b!);
  const archiveRows = (org: string, invoiceId: string) =>
    f.asOrg(org, async (c) => (await c.query("select * from document_archive where invoice_id = $1 order by created_at", [invoiceId])).rows);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  /** erwartet einen DB-Fehler mit passender Meldung (Trigger/RLS) */
  const rejects = async (p: Promise<unknown>, re: RegExp) => {
    let err: unknown = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err, "Fehler erwartet").not.toBeNull();
    const e = err as Error & { cause?: { message?: string } };
    expect(`${e.message} ${e.cause?.message ?? ""}`).toMatch(re);
  };

  async function setup() {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    await f.asOrg(org, (c) => c.query("update organizations set iban = 'DE02120300000000202051', street = 'Musterweg 1', zip = '14467', city = 'Potsdam', tax_number = '046/123/45678' where id = $1", [org]));
    const patient = await f.asOrg(org, async (c) =>
      (
        await c.query(
          "insert into patients (organization_id, number, last_name, first_name, street, zip, city, email) values ($1, 1, 'Muster', 'Erika', 'Altweg 1', '14469', 'Potsdam', 'erika@example.org') returning id",
          [org],
        )
      ).rows[0].id as string,
    );
    return { org, user, auth: authFor(org, user), patient };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.INTEGRATIONS_MODE = "mock";
    invoices = await import("./invoices");
    delivery = await import("./invoice-delivery");
    receipts = await import("./payment-receipts");
    webhooks = await import("./webhooks");
    ({ withOrg } = await import("@/db"));
    today = (await import("@/lib/format")).berlinDateIso();
    const root = process.env.STORAGE_DIR!;
    (await import("@/lib/storage")).setStorageDriver({
      put: async (k, d) => {
        if (failPut) throw new Error("Ablage nicht erreichbar (Test)");
        await mkdir(path.dirname(path.join(root, k)), { recursive: true });
        await writeFile(path.join(root, k), d, { flag: "wx" });
      },
      get: (k) => readFile(path.join(root, k)),
      remove: (k) => rm(path.join(root, k), { force: true }),
    });
  });
  afterAll(async () => {
    await f.end();
    await owner.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Ausstellen archiviert das PDF (SHA-256); Download/E-Mail/Portal liefern es byte-gleich – auch nach Stammdaten-Änderung", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    const [row] = await archiveRows(org, inv.id);
    expect(row).toMatchObject({ kind: "invoice", mime: "application/pdf", filename: `${inv.number}.pdf`, payment_receipt_id: null });
    // Aufbewahrung zur Laufzeit berechnet: Buchungsbeleg 8 Jahre ab Ende des Ausstellungsjahres (nicht gespeichert)
    expect(row.retain_until).toBeUndefined();
    expect((await bundle(org, inv.id)).archive?.retainUntil).toBe(`${Number(today.slice(0, 4)) + 8}-12-31`);

    const a = await delivery.invoicePdfForOrg(org, inv.id);
    expect(a?.variant).toBe("archive");
    expect(sha(a!.bytes)).toBe(row.sha256);
    expect(a!.bytes.length).toBe(row.size_bytes);
    // Patientenportal: dieselbe Funktion mit Personenbindung
    const portal = await delivery.invoicePdfForOrg(org, inv.id, { patientId: patient });
    expect(Buffer.from(portal!.bytes).equals(Buffer.from(a!.bytes))).toBe(true);

    // Praxis zieht um, Person ändert die Anschrift → Archiv-PDF unverändert, Druckansicht zeigt den Stand der Ausstellung
    await f.asOrg(org, (c) => c.query("update organizations set name = 'Neue Praxis', street = 'Neuweg 9', iban = 'DE89370400440532013000' where id = $1", [org]));
    await f.asOrg(org, (c) => c.query("update patients set street = 'Neuweg 2', city = 'Berlin' where id = $1", [patient]));
    const b = await delivery.invoicePdfForOrg(org, inv.id);
    expect(Buffer.from(b!.bytes).equals(Buffer.from(a!.bytes))).toBe(true);
    const view = await bundle(org, inv.id);
    expect(view.fromSnapshot).toBe(true);
    expect(view.organization).toMatchObject({ name: "Testpraxis Fuß", street: "Musterweg 1", iban: "DE02120300000000202051" });
    expect(view.patient).toMatchObject({ street: "Altweg 1", city: "Potsdam", email: "erika@example.org" });
    // E-Mail-Versand nutzt dieselbe Auslieferung (Anhang = Archiv)
    const sent = await delivery.sendInvoiceEmail(auth, inv.id);
    expect(sent.mock).toBe(true);
  });

  it("beschädigte Archivdatei wird erkannt (Prüfsumme/GCM) und nicht stillschweigend neu erzeugt", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    const [row] = await archiveRows(org, inv.id);
    const file = path.join(process.env.STORAGE_DIR!, row.storage_key);
    const buf = readFileSync(file);
    buf[buf.length - 1] ^= 0xff;
    writeFileSync(file, buf);
    await rejects(delivery.invoicePdfForOrg(org, inv.id), /archivierte Beleg/);
  });

  it("Archiv, Zahlungsbelege und Anrechnungen sind unveränderbar; Momentaufnahme an der Rechnung ebenso", async () => {
    const { org, auth, patient } = await setup();
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Nagelspange", amountCents: 1500, vatRate: 0, method: "cash", notes: null });
    const inv = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    await invoices.addPayments(auth, inv.id, [pay("cash", 5000)]);
    for (const t of ["document_archive", "payment_receipts", "invoice_credits"]) {
      const n = await f.asOrg(org, async (c) => (await c.query(`select count(*)::int as n from ${t} where organization_id = $1`, [org])).rows[0].n);
      expect(n, t).toBeGreaterThan(0);
      // App-Rolle: zusätzlich zum Trigger kein UPDATE/DELETE-Recht (scripts/migrate.ts) bzw. Trigger lehnt ab
      await rejects(f.asOrg(org, (c) => c.query(`update ${t} set created_at = now() where organization_id = $1`, [org])), /unveränderbar|permission denied/);
      await rejects(f.asOrg(org, (c) => c.query(`delete from ${t} where organization_id = $1`, [org])), /unveränderbar|permission denied/);
      // auch der Eigentümer (Trigger, nicht nur Rechte)
      await rejects(owner.query(`begin; select set_config('app.org_id', '${org}', true); update ${t} set created_at = now() where organization_id = '${org}'; commit;`), /unveränderbar/);
      await owner.query("rollback").catch(() => undefined);
      await rejects(owner.query(`begin; select set_config('app.org_id', '${org}', true); delete from ${t} where organization_id = '${org}'; commit;`), /unveränderbar/);
      await owner.query("rollback").catch(() => undefined);
      await rejects(owner.query(`truncate ${t}`), /TRUNCATE|nicht erlaubt|unveränderbar|verboten/i);
    }
    await rejects(f.asOrg(org, (c) => c.query("update invoices set issued_snapshot = '{}'::jsonb where id = $1", [inv.id])), /unveränderbar/);
  });

  it("RLS: fremde Praxis sieht weder Archiv noch Zahlungsbelege und kann keine fremde Rechnung archivieren", async () => {
    const a = await setup();
    const b = await setup();
    const inv = await invoices.createInvoice(a.auth, base(a.patient));
    await invoices.addPayments(a.auth, inv.id, [pay("cash", 6500)]);
    for (const t of ["document_archive", "payment_receipts"]) {
      const seen = await f.asOrg(b.org, async (c) => (await c.query(`select count(*)::int as n from ${t} where invoice_id = $1`, [inv.id])).rows[0].n);
      expect(seen, t).toBe(0);
    }
    expect(await delivery.invoicePdfForOrg(b.org, inv.id)).toBeNull();
    const [rec] = (await bundle(a.org, inv.id)).paymentReceipts;
    expect(await receipts.paymentReceiptPdfForOrg(b.org, inv.id, rec.id)).toBeNull();
    // Archivzeile für die Rechnung der anderen Praxis anlegen: Insert-Guard (bzw. RLS) lehnt ab
    await rejects(
      f.asOrg(b.org, (c) =>
        c.query(
          "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename) values ($1,'invoice',$2,$4,1,$3,'x.pdf')",
          [b.org, inv.id, "0".repeat(64), `${b.org}/2026/01/x.bin`],
        ),
      ),
      /Rechnung nicht gefunden|row-level security|duplicate/,
    );
    // mit fremder organization_id: RLS (WITH CHECK)
    await rejects(
      f.asOrg(b.org, (c) =>
        c.query(
          "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename) values ($1,'invoice',$2,$4,1,$3,'x.pdf')",
          [a.org, inv.id, "0".repeat(64), `${a.org}/2026/01/x.bin`],
        ),
      ),
      /Rechnung nicht gefunden|row-level security/,
    );
    // eigene Rechnung, aber Datei im Ablagebereich einer anderen Praxis: abgelehnt (Trigger + Constraint)
    const own = await invoices.createInvoice(b.auth, base(b.patient));
    await rejects(
      f.asOrg(b.org, (c) =>
        c.query(
          "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename) values ($1,'invoice',$2,$4,1,$3,'x.pdf')",
          [b.org, own.id, "0".repeat(64), `${a.org}/2026/01/x.bin`],
        ),
      ),
      /Ablagebereich/,
    );
  });

  it("Kassenbeleg bei späterer Barzahlung: eigene Nummer, Verweis auf die Rechnung, TSE-Angaben (Testmodus), archiviert", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    drawn = [];
    const res = await invoices.addPayments(auth, inv.id, [pay("cash", 2500), pay("transfer", 1000)]);
    // nur der Kassenvorgang (bar) bekommt einen Beleg – die Überweisung nicht
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].number).toMatch(new RegExp(`^ZB${today.slice(0, 4)}-0001$`));
    const text = drawn.join("\n");
    expect(text).toContain(`Beleg über Zahlungseingang zu Rechnung Nr. ${inv.number} vom`);
    for (const label of ["TSE-Seriennummer", "TSE-Transaktionsnummer", "TSE-Signaturzähler", "TSE-Vorgangsbeginn", "TSE-Vorgangsende", "TSE-Signatur"]) expect(text).toContain(label);
    expect(text).toContain("TESTMODUS");
    // Stand nach dieser Zahlung (die Überweisung derselben Erfassung kam danach)
    expect(text).toMatch(/Noch offen: 40,00\s€\./);
    expect(text).not.toMatch(/USt \d+ %/);

    const view = await bundle(org, inv.id);
    expect(view.paymentReceipts).toHaveLength(1);
    const r = view.paymentReceipts[0];
    expect(r).toMatchObject({ number: res.receipts[0].number, amountCents: 2500, method: "cash", isTest: true, tseFailed: false, archived: true });
    const row = await f.asOrg(org, async (c) => (await c.query("select data from payment_receipts where id = $1", [r.id])).rows[0]);
    expect(row.data.fiscal).toMatchObject({ isTest: true, processType: "Kassenbeleg-V1" });
    expect(row.data.fiscal.tssSerial).toBeTruthy();
    expect(row.data.invoice).toMatchObject({ number: inv.number });
    // Abruf: archiviertes Original (byte-gleich, Prüfsumme)
    const pdf1 = await receipts.paymentReceiptPdfForOrg(org, inv.id, r.id);
    const pdf2 = await receipts.paymentReceiptPdfForOrg(org, inv.id, r.id);
    const [arch] = (await archiveRows(org, inv.id)).filter((x) => x.kind === "payment_receipt");
    expect(sha(pdf1!.bytes)).toBe(arch.sha256);
    expect(Buffer.from(pdf1!.bytes).equals(Buffer.from(pdf2!.bytes))).toBe(true);
    // der Rechnungsbeleg selbst bleibt wie ausgestellt (keine TSE-Angaben der späteren Zahlung)
    const invPdf = await delivery.invoicePdfForOrg(org, inv.id);
    expect(invPdf?.variant).toBe("archive");
    // zweite Barzahlung: fortlaufende Nummer
    const res2 = await invoices.addPayments(auth, inv.id, [pay("cash", 3000)]);
    expect(res2.receipts[0].number).toMatch(/-0002$/);
  });

  it("Zahlungsbeleg übernimmt den Kleinunternehmer-Status der Rechnung (Momentaufnahme), nicht den heutigen", async () => {
    const { org, auth, patient } = await setup();
    await f.asOrg(org, (c) => c.query("update organizations set small_business = true where id = $1", [org]));
    const inv = await invoices.createInvoice(auth, base(patient));
    const snap = await f.asOrg(org, async (c) => (await c.query("select issued_snapshot from invoices where id = $1", [inv.id])).rows[0].issued_snapshot);
    expect(snap.smallBusinessNote).toBe("Steuerbefreiung für Kleinunternehmer (§ 19 UStG).");
    await f.asOrg(org, (c) => c.query("update organizations set small_business = false where id = $1", [org]));
    drawn = [];
    const res = await invoices.addPayments(auth, inv.id, [pay("cash", 6500)]);
    const data = await f.asOrg(org, async (c) => (await c.query("select data from payment_receipts where id = $1", [res.receipts[0].id])).rows[0].data);
    expect(data.organization.smallBusiness).toBe(true);
    expect(drawn.join(" ")).toMatch(/Steuerbefreiung für Kleinunternehmer \(§ 19 UStG\)/);
    // Druckansicht/Neudruck der Rechnung behalten Status und Wortlaut der Ausstellung
    const b = await bundle(org, inv.id);
    expect(b.organization.smallBusiness).toBe(true);
    expect(b.smallBusinessNote).toBe("Steuerbefreiung für Kleinunternehmer (§ 19 UStG).");
  });

  it("Quittung bar beim Ausstellen trägt die TSE-Angaben auf dem Beleg selbst (kein zusätzlicher Zahlungsbeleg)", async () => {
    const { org, auth, patient } = await setup();
    drawn = [];
    const rec = await invoices.createInvoice(auth, base(patient, { kind: "receipt", payments: [pay("cash", 6500)] }));
    expect(drawn).toContain("TSE-Angaben");
    expect(drawn).toContain("TSE-Signaturzähler");
    expect((await bundle(org, rec.id)).paymentReceipts).toEqual([]);
  });

  it("SumUp-Terminalzahlung (Karte) erzeugt einen Zahlungsbeleg mit TSE-Angaben; Zahlungslink nicht", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    const r1 = await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:t-${inv.id}`, amountCents: 3000, method: "card" });
    expect(r1.status).toBe("gebucht");
    const r2 = await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:l-${inv.id}`, amountCents: 3500, method: "payment_link" });
    expect(r2.status).toBe("gebucht");
    const list = (await bundle(org, inv.id)).paymentReceipts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ method: "card", amountCents: 3000, archived: true, tseFailed: false });
  });

  it("Storno: Neudruck wie ausgestellt mit Anrechnungszeilen und Stornovermerk, ohne GiroCode; Anzahlung wieder anrechenbar", async () => {
    const { org, auth, patient } = await setup();
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Nagelspange", amountCents: 1500, vatRate: 0, method: "cash", notes: null });
    const inv = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    const original = await delivery.invoicePdfForOrg(org, inv.id);
    const credit = await invoices.cancelInvoice(auth, inv.id, "Doppelt erstellt");
    // Stornorechnung ist ebenfalls archiviert
    expect(await archiveRows(org, credit.id)).toHaveLength(1);
    // Freigabe: collective_invoice_id ist leer, die Anrechnung bleibt festgeschrieben
    const depRow = await f.asOrg(org, async (c) => (await c.query("select collective_invoice_id from invoices where id = $1", [dep.id])).rows[0]);
    expect(depRow.collective_invoice_id).toBeNull();
    const view = await bundle(org, inv.id);
    expect(view.credited.map((c) => c.number)).toEqual([dep.number]);

    drawn = [];
    const reprint = await delivery.invoicePdfForOrg(org, inv.id);
    expect(reprint?.variant).toBe("storno");
    const text = drawn.join("\n");
    expect(text).toContain(`STORNIERT durch Stornorechnung Nr. ${credit.number} vom`);
    expect(drawn.some((t) => t.startsWith("abzgl. Anzahlung"))).toBe(true);
    expect(text).not.toContain("Bezahlen per GiroCode");
    expect(text).not.toContain("Reproduktion");
    // Original aus dem Archiv weiter abrufbar (byte-gleich)
    const orig = await delivery.invoicePdfForOrg(org, inv.id, { original: true });
    expect(Buffer.from(orig!.bytes).equals(Buffer.from(original!.bytes))).toBe(true);

    // Anzahlung kann auf eine neue Rechnung angerechnet werden
    const again = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    expect((await bundle(org, again.id)).credited.map((c) => c.number)).toEqual([dep.number]);
    // die stornierte Rechnung zeigt sie weiterhin
    expect((await bundle(org, inv.id)).credited.map((c) => c.number)).toEqual([dep.number]);
    // nachträgliche Anrechnung auf die stornierte Rechnung: nur in der Migration (podo.backfill), nie aus der App
    const dep2 = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: zweite", amountCents: 1000, vatRate: 0, method: "cash", notes: null });
    await rejects(
      f.asOrg(org, (c) => c.query("insert into invoice_credits (organization_id, invoice_id, credited_invoice_id, amount_cents) values ($1,$2,$3,1000)", [org, inv.id, dep2.id])),
      /nicht auf diese Rechnung angerechnet/,
    );
  });

  /** Test-Trigger (Eigentümer) für genau eine Praxis bzw. Rechnung; wird nach dem Block wieder entfernt */
  async function withFailingTrigger<T>(table: string, when: string, fn: () => Promise<T>, opts: { deferred?: boolean } = {}): Promise<T> {
    const name = `test_fail_${Math.random().toString(36).slice(2, 10)}`;
    await owner.query(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'Testfehler ${table}'; end $$`);
    await owner.query(
      opts.deferred
        ? `create constraint trigger ${name} after insert on ${table} deferrable initially deferred for each row when (${when}) execute function ${name}()`
        : `create trigger ${name} before insert on ${table} for each row when (${when}) execute function ${name}()`,
    );
    try {
      return await fn();
    } finally {
      await owner.query(`drop trigger ${name} on ${table}`);
      await owner.query(`drop function ${name}()`);
    }
  }
  const binFiles = async (org: string) => {
    const dir = path.join(process.env.STORAGE_DIR!, org);
    return existsSync(dir) ? (await import("node:fs")).readdirSync(dir, { recursive: true }).map(String).filter((x) => x.endsWith(".bin")) : [];
  };
  const fiscalCount = (org: string) => f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from fiscal_transactions")).rows[0].n as number);

  it("Archivfehler beim Ausstellen (Quittung bar): Beleg gültig, genau eine TSE-Signatur, keine Datei übrig, Meldung; Abruf holt nach", async () => {
    const { org, auth, patient } = await setup();
    const rec = await withFailingTrigger("document_archive", `new.organization_id = '${org}'::uuid`, () =>
      invoices.createInvoice(auth, base(patient, { kind: "receipt", payments: [pay("cash", 6500)] })),
    );
    expect(rec.number).toMatch(/-0001$/);
    // nichts zurückgerollt → keine erneute Ausstellung nötig → keine zweite Signatur
    expect(await fiscalCount(org)).toBe(1);
    expect(await archiveRows(org, rec.id)).toEqual([]);
    expect(await binFiles(org)).toEqual([]);
    const inbox = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from messages where subject like 'Beleg % konnte nicht archiviert werden'")).rows[0].n);
    expect(inbox).toBe(1);
    // Abruf holt das Archiv aus den festgeschriebenen Daten nach (mit TSE-Angaben der Zahlung beim Ausstellen)
    drawn = [];
    const pdf = await delivery.invoicePdfForOrg(org, rec.id);
    expect(pdf?.variant).toBe("archive");
    expect(drawn).toContain("TSE-Signaturzähler");
    expect(await archiveRows(org, rec.id)).toHaveLength(1);
    expect(await fiscalCount(org)).toBe(1);
  });

  it("Fehler erst beim COMMIT: Rollback entfernt die nicht verzeichnete Datei, die Rechnungsnummer ist nicht verbraucht", async () => {
    const { org, auth, patient } = await setup();
    await withFailingTrigger(
      "document_archive",
      `new.organization_id = '${org}'::uuid`,
      () => rejects(invoices.createInvoice(auth, base(patient)), /Testfehler document_archive/),
      { deferred: true },
    );
    expect(await binFiles(org)).toEqual([]);
    expect(await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from invoices")).rows[0].n)).toBe(0);
    expect((await invoices.createInvoice(auth, base(patient))).number).toMatch(/-0001$/);
  });

  it("Aufräumen nach einem Fehler NACH dem COMMIT: verzeichnete Datei bleibt erhalten", async () => {
    const { org, patient } = await setup();
    const legacy = await f.invoice(org, patient);
    const archive = await import("./document-archive");
    await rejects(
      archive.withArchiveCleanup(org, async (pending) => {
        await withOrg(org, (tx) => archive.archivePdf(tx, org, { kind: "invoice", invoiceId: legacy, bytes: new Uint8Array([37, 80, 68, 70]), filename: "T.pdf", userId: null }, pending));
        throw new Error("Fehler nach dem Commit");
      }),
      /nach dem Commit/,
    );
    const [row] = await archiveRows(org, legacy);
    expect(row).toBeTruthy();
    expect(await binFiles(org)).toHaveLength(1);
    expect(Buffer.from(await archive.readArchivedPdf({ id: row.id, storageKey: row.storage_key, sha256: row.sha256, sizeBytes: row.size_bytes, organizationId: org })).toString()).toBe("%PDF");
  });

  it("Fehler beim Anlegen des Zahlungsbelegs (Webhook und „Zahlung erfassen“): Zahlung gebucht, eine Signatur, Meldung", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    const inv2 = await invoices.createInvoice(auth, base(patient));
    await withFailingTrigger("payment_receipts", `new.organization_id = '${org}'::uuid`, async () => {
      const r = await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:pr-${inv.id}`, amountCents: 6500, method: "card" });
      expect(r.status).toBe("gebucht");
      // erneute Zustellung: bereits gebucht, keine zweite Signatur
      expect((await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:pr-${inv.id}`, amountCents: 6500, method: "card" })).status).toBe("bereits gebucht");
      const res = await invoices.addPayments(auth, inv2.id, [pay("cash", 6500)]);
      expect(res).toMatchObject({ status: "paid", receipts: [] });
    });
    expect(await fiscalCount(org)).toBe(2);
    const b = await bundle(org, inv.id);
    expect(b.invoice.status).toBe("paid");
    expect(b.paymentReceipts).toEqual([]);
    const inbox = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from messages where subject like 'Zahlungsbeleg zu Rechnung % konnte nicht angelegt werden'")).rows[0].n);
    expect(inbox).toBe(2);
  });

  it("zurückgerollter Zahlungsbeleg in paralleler Buchung: Nummern der übrigen bleiben lückenlos", async () => {
    const { auth, patient } = await setup();
    const list: { id: string; number: string }[] = [];
    for (let i = 0; i < 4; i++) list.push(await invoices.createInvoice(auth, base(patient)));
    const res = await withFailingTrigger("payment_receipts", `new.invoice_id = '${list[1].id}'::uuid`, () =>
      Promise.all(list.map((inv) => invoices.addPayments(auth, inv.id, [pay("cash", 6500)]))),
    );
    const y = today.slice(0, 4);
    expect(res.flatMap((r) => r.receipts.map((x) => x.number)).sort()).toEqual([1, 2, 3].map((n) => `ZB${y}-000${n}`));
  });

  it("gleichzeitiges Nachholen: genau ein Archiv je Beleg, beide Abrufe byte-gleich; Nachhol-Lauf erfasst übrige", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    failPut = true;
    let r1: Awaited<ReturnType<typeof invoices.addPayments>>;
    let r2: Awaited<ReturnType<typeof invoices.addPayments>>;
    const inv2 = await invoices.createInvoice(auth, base(patient));
    try {
      r1 = await invoices.addPayments(auth, inv.id, [pay("cash", 6500)]);
      r2 = await invoices.addPayments(auth, inv2.id, [pay("cash", 6500)]);
    } finally {
      failPut = false;
    }
    const id = r1.receipts[0].id;
    const [a, b] = await Promise.all([receipts.paymentReceiptPdfForOrg(org, inv.id, id), receipts.paymentReceiptPdfForOrg(org, inv.id, id)]);
    expect([a?.variant, b?.variant]).toEqual(["archive", "archive"]);
    expect(Buffer.from(a!.bytes).equals(Buffer.from(b!.bytes))).toBe(true);
    expect((await archiveRows(org, inv.id)).filter((x) => x.kind === "payment_receipt")).toHaveLength(1);
    // der zweite Beleg wird vom Nachhol-Lauf (Cron/Export) erfasst
    const catchUp = await import("./archive-catchup");
    expect((await catchUp.missingArchives(org)).receipts.map((x) => x.id)).toEqual([r2.receipts[0].id]);
    const run = await catchUp.catchUpArchives({ organizationIds: [org] });
    expect(run.receipts).toEqual({ ok: 1, failed: 0 });
    expect((await catchUp.missingArchives(org)).receipts).toEqual([]);
    // nachträglich erzeugtes Original: kein Reproduktions-Vermerk
    drawn = [];
    await receipts.paymentReceiptPdfForOrg(org, inv2.id, r2.receipts[0].id);
    expect(drawn.join(" ")).not.toMatch(/Reproduktion/);
  });

  it("Migration 0049 auf einer Datenbank mit der früheren Fassung (retain_until, alter Datei-Constraint): danach ausstellbar", async () => {
    const dbName = `podo_alt_${Math.random().toString(36).slice(2, 8)}`;
    await owner.query(`create database ${dbName}`);
    const url = (process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? "")).replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const alt = new Pool({ connectionString: url, max: 1 });
    // Beim DROP … WITH (FORCE) beendet Postgres evtl. noch offene Verbindungen (57P01); ohne Listener
    // wäre das ein „Unhandled Error“, der den ganzen vitest-Lauf rot macht.
    // pool.end() wartet nicht, bis die Sockets zu sind; der Client ist dann schon aus dem Pool entfernt und
    // meldet 57P01 an sich selbst – daher den Listener auch je Client setzen.
    alt.on("error", () => {});
    alt.on("connect", (c) => c.on("error", () => {}));
    try {
      await alt.query("create extension if not exists pgcrypto");
      await alt.query("create extension if not exists pg_trgm");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(drizzle(alt), { migrationsFolder: path.join(__dirname, "../../drizzle") });
      // frühere Fassung nachstellen
      await alt.query(`alter table document_archive add column retain_until date not null`);
      await alt.query(`alter table document_archive drop constraint document_archive_file_check`);
      await alt.query(
        `alter table document_archive add constraint document_archive_file_check check (mime = 'application/pdf' and size_bytes > 0 and sha256 ~ '^[0-9a-f]{64}$')`,
      );
      // 0049 läuft erneut (geänderter Zeitstempel) → gleicht an
      await alt.query(MIGRATION);
      const cols = (await alt.query("select column_name from information_schema.columns where table_name = 'document_archive'")).rows.map((r) => r.column_name);
      expect(cols).not.toContain("retain_until");
      const org = (await alt.query("insert into organizations (name, slug) values ('Alt', 'alt-test') returning id")).rows[0].id as string;
      await alt.query("begin");
      await alt.query("select set_config('app.org_id', $1, true)", [org]);
      const inv = (await alt.query("insert into invoices (organization_id, status) values ($1, 'draft') returning id", [org])).rows[0].id as string;
      await alt.query("update invoices set status = 'issued', number = 'R2026-0001', issued_at = '2026-11-14' where id = $1", [inv]);
      await alt.query(
        "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename) values ($1, 'invoice', $2, $3, 4, $4, 'R2026-0001.pdf')",
        [org, inv, `${org}/2026/11/00000000-0000-4000-8000-000000000000.bin`, "a".repeat(64)],
      );
      // neuer Constraint greift: fremder Ablagebereich abgelehnt
      await rejects(
        alt.query("insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename) values ($1, 'invoice', $2, 'x/y.bin', 4, $3, 'x.pdf')", [org, inv, "a".repeat(64)]),
        /Ablagebereich/,
      );
      await alt.query("rollback");
      // Guard ohne Backfill-Ausnahme nach der Migration
      const src = (await alt.query("select prosrc from pg_proc where proname = 'podo_invoice_credit_guard'")).rows[0].prosrc as string;
      expect(src).not.toContain("podo.backfill");
    } finally {
      await alt.end();
      await owner.query(`drop database ${dbName} with (force)`);
    }
  }, 120_000);

  it("parallele Barzahlungen: Zahlungsbelege lückenlos und eindeutig nummeriert", async () => {
    const { org, auth, patient } = await setup();
    const list = [];
    for (let i = 0; i < 6; i++) list.push(await invoices.createInvoice(auth, base(patient)));
    const res = await Promise.all(list.map((inv) => invoices.addPayments(auth, inv.id, [pay("cash", 6500)])));
    const numbers = res.flatMap((r) => r.receipts.map((x) => x.number)).sort();
    const y = today.slice(0, 4);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6].map((n) => `ZB${y}-000${n}`));
    const archived = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from document_archive where kind = 'payment_receipt'")).rows[0].n);
    expect(archived).toBe(6);
  });

  it("SumUp-Terminal bei Ablagefehler: Zahlung gebucht (einmal signiert), Beleg-Daten gespeichert, PDF später nachgeholt", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    const ref = `sumup:fail-${inv.id}`;
    failPut = true;
    try {
      const r = await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: ref, amountCents: 6500, method: "card" });
      expect(r.status).toBe("gebucht");
      // erneute Zustellung: nicht doppelt gebucht, nicht erneut signiert
      expect((await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: ref, amountCents: 6500, method: "card" })).status).toBe("bereits gebucht");
    } finally {
      failPut = false;
    }
    const counts = await f.asOrg(org, async (c) =>
      (
        await c.query(
          `select (select count(*)::int from payments where invoice_id = $1) as pays,
                  (select count(*)::int from fiscal_transactions ft join payments p on p.id = ft.payment_id where p.invoice_id = $1) as sigs,
                  (select count(*)::int from payment_receipts where invoice_id = $1) as receipts,
                  (select count(*)::int from document_archive where invoice_id = $1 and kind = 'payment_receipt') as archived,
                  (select count(*)::int from messages where subject like 'Zahlungsbeleg % konnte nicht abgelegt werden') as inbox`,
          [inv.id],
        )
      ).rows[0],
    );
    expect(counts).toEqual({ pays: 1, sigs: 1, receipts: 1, archived: 0, inbox: 1 });
    const b = await bundle(org, inv.id);
    expect(b.invoice.status).toBe("paid");
    expect(b.paymentReceipts[0]).toMatchObject({ archived: false, tseFailed: false });
    // Abruf holt die Ablage nach – danach archiviertes Original (byte-gleich bei jedem Abruf)
    const p1 = await receipts.paymentReceiptPdfForOrg(org, inv.id, b.paymentReceipts[0].id);
    expect(p1?.variant).toBe("archive");
    const p2 = await receipts.paymentReceiptPdfForOrg(org, inv.id, b.paymentReceipts[0].id);
    expect(Buffer.from(p2!.bytes).equals(Buffer.from(p1!.bytes))).toBe(true);
    expect((await bundle(org, inv.id)).paymentReceipts[0].archived).toBe(true);
  });

  it("Zahlungsbeleg ohne Archiv und weiter gestörter Ablage: Reproduktion mit Kennzeichnung", async () => {
    const { org, auth, patient } = await setup();
    const inv = await invoices.createInvoice(auth, base(patient));
    failPut = true;
    try {
      const res = await invoices.addPayments(auth, inv.id, [pay("cash", 6500)]);
      expect(res.status).toBe("paid");
      drawn = [];
      const pdf = await receipts.paymentReceiptPdfForOrg(org, inv.id, res.receipts[0].id);
      expect(pdf?.variant).toBe("reproduction");
      expect(drawn.join(" ")).toMatch(/Reproduktion \(kein archiviertes Original\): Die Angaben wurden bei der Zahlung festgeschrieben/);
    } finally {
      failPut = false;
    }
  });

  it("Altbeleg ohne Archiv/Momentaufnahme: Reproduktion mit Fußnote, aktuelle Stammdaten", async () => {
    const { org, patient } = await setup();
    const id = await f.invoice(org, patient);
    drawn = [];
    const pdf = await delivery.invoicePdfForOrg(org, id);
    expect(pdf?.variant).toBe("reproduction");
    expect(drawn.join(" ")).toMatch(/Reproduktion: Dieser Beleg wurde am .* aus den gespeicherten Belegdaten mit den heutigen Stammdaten neu erzeugt/);
    const view = await bundle(org, id);
    expect(view.fromSnapshot).toBe(false);
    expect(view.archive).toBeNull();
  });

  it("Migration 0049 verknüpft Anrechnungen stornierter Altbelege aus der Stornorechnung (idempotent)", async () => {
    const { org, patient } = await setup();
    const sfx = Math.random().toString(36).slice(2, 8);
    const ids = await f.asOrg(org, async (c) => {
      const issue = async (kind: string, number: string, status: string, total: number, extra: { cancels?: string; notes?: string } = {}) => {
        const id = (
          await c.query("insert into invoices (organization_id, patient_id, kind, status, cancels_invoice_id, notes) values ($1,$2,$3,'draft',$4,$5) returning id", [
            org,
            patient,
            kind,
            extra.cancels ?? null,
            extra.notes ?? null,
          ])
        ).rows[0].id as string;
        await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Leistung',$3,$3,0,1)", [org, id, total]);
        await c.query("update invoices set status = $2, number = $3, issued_at = $4, due_at = $4, total_cents = $5, net_cents = $5, paid_cents = $6 where id = $1", [
          id,
          status,
          number,
          today,
          total,
          status === "paid" ? total : 0,
        ]);
        return id;
      };
      const dep = await issue("deposit", `AZ-${sfx}`, "paid", 1500);
      const rec = await issue("receipt", `Q-${sfx}`, "paid", 2000);
      const orig = await issue("collective", `SR-${sfx}`, "cancelled", 6500);
      await issue("credit_note", `GS-${sfx}`, "paid", -6500, {
        cancels: orig,
        notes: `Storno zu SR-${sfx} vom 01.01.2026. Grund: Test\nAngerechnete Anzahlungen (AZ-${sfx}) bleiben gültig und werden auf die neue Rechnung angerechnet.\n[intern] Angerechnete Quittungen: Q-${sfx}`,
      });
      return { dep, rec, orig };
    });
    expect((await bundle(org, ids.orig)).credited).toEqual([]);
    await owner.query(MIGRATION);
    await owner.query(MIGRATION);
    const links = await f.asOrg(org, async (c) => (await c.query("select credited_invoice_id, amount_cents from invoice_credits where invoice_id = $1 order by amount_cents", [ids.orig])).rows);
    expect(links).toEqual([
      { credited_invoice_id: ids.dep, amount_cents: 1500 },
      { credited_invoice_id: ids.rec, amount_cents: 2000 },
    ]);
    expect((await bundle(org, ids.orig)).credited.map((c) => c.number).sort()).toEqual([`AZ-${sfx}`, `Q-${sfx}`]);
  });
});
