/**
 * Beleg-Archiv (GoBD, § 14b UStG), Zahlungsbelege nach Ausstellung (§ 146a Abs. 2 AO, § 6 KassenSichV) und
 * Storno-Neudruck mit festgeschriebener Anrechnung (§ 14 Abs. 5 S. 2 UStG). Echte DB, erfundene Daten.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
    expect(String((err as Error).message)).toMatch(re);
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
    expect(row.retain_until).toBeTruthy();
    expect(Number(String(new Date(row.retain_until).getFullYear()))).toBe(Number(today.slice(0, 4)) + 10);

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
          "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename, retain_until) values ($1,'invoice',$2,'x/y.bin',1,$3,'x.pdf','2036-12-31')",
          [b.org, inv.id, "0".repeat(64)],
        ),
      ),
      /Rechnung nicht gefunden|row-level security|duplicate/,
    );
    // mit fremder organization_id: RLS (WITH CHECK)
    await rejects(
      f.asOrg(b.org, (c) =>
        c.query(
          "insert into document_archive (organization_id, kind, invoice_id, storage_key, size_bytes, sha256, filename, retain_until) values ($1,'invoice',$2,'x/y.bin',1,$3,'x.pdf','2036-12-31')",
          [a.org, inv.id, "0".repeat(64)],
        ),
      ),
      /Rechnung nicht gefunden|row-level security/,
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
  });

  it("Altbeleg ohne Archiv/Momentaufnahme: Reproduktion mit Fußnote, aktuelle Stammdaten", async () => {
    const { org, patient } = await setup();
    const id = await f.invoice(org, patient);
    drawn = [];
    const pdf = await delivery.invoicePdfForOrg(org, id);
    expect(pdf?.variant).toBe("reproduction");
    expect(drawn.join(" ")).toMatch(/Reproduktion: Dieser Beleg wurde am .* aus den gespeicherten Belegdaten neu erzeugt/);
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
