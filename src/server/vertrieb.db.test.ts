/**
 * Vertrieb: Versand-Ablauf gegen eine echte Datenbank mit gemocktem MailPort (es wird nichts versendet).
 * Import → Vorschau → Senden (Kopfzeilen, Abmeldelink, Protokoll) → Abstände → Stopp-Status → Abmeldung → Limits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// Audit-Einträge ohne Praxis sind per RLS für die App-Rolle nicht lesbar → Aufrufe mitschneiden (echtes Schreiben bleibt)
vi.mock("@/lib/audit", async (orig) => {
  const m = await orig<typeof import("@/lib/audit")>();
  return { audit: vi.fn(m.audit) };
});
import { MailSendError, MockMailAdapter, type MailMessage, type MailPort } from "@/integrations/mail/mail";
import { MAX_PER_DAY } from "@/lib/vertrieb/constants";
import { verifyUnsubscribeToken } from "@/lib/vertrieb/unsubscribe-token";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const env = { PUBLIC_URL: "https://podo.example", NODE_ENV: "test" };
const day = 86_400_000;

(TEST_DB ? describe : describe.skip)("Vertrieb (DB)", () => {
  const f = fixtures(TEST_DB!);
  let v: typeof import("./vertrieb");
  let admin: string;
  let auditCalls: () => { action: string; entityId?: string; meta?: Record<string, unknown> }[];
  const t0 = new Date("2026-11-10T09:00:00Z");

  const leadByName = async (name: string) => (await f.pool.query("select * from sales_leads where name = $1", [name])).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    v = await import("./vertrieb");
    const { audit } = await import("@/lib/audit");
    auditCalls = () => vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; entityId?: string; meta?: Record<string, unknown> });
    await f.pool.query("delete from sales_sends; delete from sales_leads; delete from sales_suppressions; delete from sales_blocklist; delete from sales_settings; delete from sales_campaigns");
    admin = await f.user();
  });
  afterAll(async () => {
    // Einlösungen darf die App-Rolle nicht löschen → als Eigentümer aufräumen
    const { Pool } = await import("pg");
    const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? TEST_DB, max: 1 });
    await owner.query("delete from promo_redemptions where code_id in (select id from promo_codes where code like 'TPIPE%')");
    await owner.query("delete from promo_codes where code like 'TPIPE%'");
    await owner.end();
    await f.pool.query("delete from sales_sends; delete from sales_leads; delete from sales_suppressions; delete from sales_blocklist; delete from sales_settings; delete from sales_campaigns");
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("ohne Absender/Impressum wird nicht gesendet", async () => {
    await expect(v.sendNextMails(admin, [], { port: new MockMailAdapter(), env })).rejects.toThrow(/Impressum|Absender/);
  });

  it("Import mit Dubletten und Sperrliste", async () => {
    // Altbestand (Klartext, bis 0042) wird beim ersten Zugriff in Prüfwerte überführt und gelöscht
    await f.pool.query("insert into sales_suppressions (email, reason) values ('gesperrt@praxis.example', 'abgemeldet')");
    await v.saveSalesSettings(admin, {
      senderName: "Max Betreiber",
      senderEmail: "max@podo.example",
      replyTo: "",
      impressum: "AlgoVerdict GmbH, Musterstraße 1, 12345 Musterstadt, kontakt@podo.example",
      delay2Days: 5,
      delay3Days: 10,
      mailProcessorConfirmed: true,
    });
    const csv = [
      "name;email;zip;city;contact_person",
      "Podologie Eins;eins@praxis.example;11111;Musterstadt;Frau Eins",
      "Podologie Zwei;ZWEI@praxis.example;22222;Musterstadt;",
      "Podologie Zwei Kopie;zwei@praxis.example;22223;Musterstadt;",
      "Gesperrte Praxis;gesperrt@praxis.example;33333;Musterstadt;",
    ].join("\n");
    const p = await v.previewImport(csv);
    expect(p.newCount).toBe(2);
    expect(await v.importLeads(admin, csv, " ")).toMatchObject({ imported: 0, error: expect.stringMatching(/Quelle/) });
    const r = await v.importLeads(admin, csv, "Messe Test 2026");
    expect(r).toEqual({ imported: 2, skipped: 2 });
    expect((await v.importLeads(admin, csv, "Messe Test 2026")).imported).toBe(0);
    expect((await leadByName("Podologie Eins")).source).toBe("Messe Test 2026");
    // Altbestand überführt: kein Klartext mehr, nur Prüfwert
    expect((await f.pool.query("select count(*)::int as n from sales_suppressions")).rows[0].n).toBe(0);
    expect((await f.pool.query("select hash, reason from sales_blocklist where reason = 'abgemeldet'")).rows.every((r: { hash: string }) => /^v1:[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    const bl = await import("./blocklist");
    expect(await bl.isBlocked(" Gesperrt@Praxis.example")).toBe(true);
    await expect(v.createLead(admin, { name: "Gesperrt neu", contactPerson: null, email: "gesperrt@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null })).rejects.toThrow(/Sperrliste/);
    expect(auditCalls().filter((a) => a.action === "vertrieb.import").map((a) => a.meta)).toEqual([{ imported: 2, skipped: 2, source: "Messe Test 2026" }, { imported: 0, skipped: 4, source: "Messe Test 2026" }]);
    expect(auditCalls().some((a) => a.action === "vertrieb.settings")).toBe(true);
  });

  it("Vorschau zeigt genau die erste Mail; Senden protokolliert, setzt Schritt/Status, Kopfzeilen und Abmeldelink", async () => {
    const eins = await leadByName("Podologie Eins");
    const zwei = await leadByName("Podologie Zwei");
    // ohne dokumentierte Einwilligung (§ 7 Abs. 2 Nr. 2 UWG) wird nie gesendet – auch nicht serverseitig
    const none = await v.previewSend([eins.id, zwei.id], { now: t0, env });
    expect(none.count).toBe(0);
    expect(none.skipped.map((x) => x.reason)).toEqual(["keine dokumentierte Einwilligung", "keine dokumentierte Einwilligung"]);
    const noPort = new MockMailAdapter();
    expect(await v.sendNextMails(admin, [eins.id], { port: noPort, now: () => t0, env })).toMatchObject({ sent: 0, skipped: 1 });
    expect(noPort.sent).toHaveLength(0);
    await expect(v.recordLeadConsent(admin, eins.id, " x ")).rejects.toThrow(/Wortlaut, Kanal und Datum/);
    expect(await v.recordLeadConsent(admin, eins.id, "Anfrage per E-Mail vom 01.11.2026")).toBe(true);
    expect(await v.recordLeadConsent(admin, zwei.id, "Anfrage per E-Mail vom 01.11.2026")).toBe(true);
    expect(await leadByName("Podologie Eins")).toMatchObject({ consent_note: "Anfrage per E-Mail vom 01.11.2026" });
    await expect(f.pool.query("update sales_leads set consent_note = null where id = $1", [eins.id])).rejects.toThrow(/sales_leads_consent_check/);
    const pre = await v.previewSend([eins.id, zwei.id], { now: t0, env });
    expect(pre.problems).toEqual([]);
    expect(pre.count).toBe(2);
    expect(pre.first).toMatchObject({ to: "eins@praxis.example", from: '"Max Betreiber" <max@podo.example>', step: 1 });
    expect(pre.first!.text).toMatch(/^Guten Tag Frau Eins,/);

    const port = new MockMailAdapter();
    const r = await v.sendNextMails(admin, [eins.id, zwei.id], { port, now: () => t0, env });
    expect(r).toMatchObject({ sent: 2, failed: [], skipped: 0 });
    expect(port.sent).toHaveLength(2);
    const m = port.sent[0];
    expect(m).toMatchObject({ to: "eins@praxis.example", from: '"Max Betreiber" <max@podo.example>', replyTo: "max@podo.example", subject: pre.first!.subject });
    expect(m.text).toBe(pre.first!.text);
    expect(m.text).toContain("AlgoVerdict GmbH");
    expect(m.text).toContain("Widerspruchsrecht nach Art. 21 DSGVO:\nhttps://podo.example/datenschutz#vertrieb");
    const link = /https:\/\/podo\.example\/abmelden\/(\S+)/.exec(m.text)![1];
    expect(verifyUnsubscribeToken(link)).toBe(eins.id);
    expect(m.text).not.toContain(eins.id);
    expect(m.headers?.["List-Unsubscribe"]).toContain(`https://podo.example/abmelden/${link}`);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(port.sent[1].text).toMatch(/^Guten Tag,/);

    const after = await leadByName("Podologie Eins");
    expect(after).toMatchObject({ step: 1, status: "in_sequenz" });
    const sends = await f.pool.query("select step, ok, mock, sent_by from sales_sends where lead_id = $1", [eins.id]);
    expect(sends.rows).toEqual([{ step: 1, ok: true, mock: true, sent_by: admin }]);
    expect((await v.getLead(eins.id))!.sends).toHaveLength(1);
    expect(auditCalls().filter((a) => a.action === "vertrieb.send").at(-1)?.meta).toMatchObject({ sent: 2, failed: 0, skipped: 0, mock: true });
  });

  it("Mail 2 erst nach dem Abstand; Doppelklick sendet nicht doppelt", async () => {
    const eins = await leadByName("Podologie Eins");
    const port = new MockMailAdapter();
    expect((await v.sendNextMails(admin, [eins.id], { port, now: () => new Date(t0.getTime() + 4 * day), env })).sent).toBe(0);
    const later = () => new Date(t0.getTime() + 5 * day + 1000);
    const [a, b] = await Promise.all([
      v.sendNextMails(admin, [eins.id], { port, now: later, env }),
      v.sendNextMails(admin, [eins.id], { port, now: later, env }),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].subject).toContain("Podologie Eins");
    expect(await leadByName("Podologie Eins")).toMatchObject({ step: 2 });
  });

  it("Status „geantwortet“ stoppt die Sequenz", async () => {
    const zwei = await leadByName("Podologie Zwei");
    await v.setLeadStatus(admin, zwei.id, "geantwortet");
    const port = new MockMailAdapter();
    const r = await v.sendNextMails(admin, [zwei.id], { port, now: () => new Date(t0.getTime() + 30 * day), env });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(port.sent).toHaveLength(0);
    expect(auditCalls().find((a) => a.action === "vertrieb.status" && a.entityId === zwei.id)?.meta).toEqual({ from: "in_sequenz", to: "geantwortet" });
  });

  it("Abmeldung per Token: Sperrliste + Status, danach kein Versand und kein Neu-Import", async () => {
    const eins = await leadByName("Podologie Eins");
    const port = new MockMailAdapter();
    const r = await v.sendNextMails(admin, [eins.id], { port, now: () => new Date(t0.getTime() + 30 * day), env });
    const token = /\/abmelden\/(\S+)/.exec(port.sent[0].text)![1];
    expect(await v.unsubscribeByToken("kaputt")).toBe(false);
    expect(await v.unsubscribeByToken(token)).toBe(true);
    expect(await v.unsubscribeByToken(token)).toBe(true);
    expect(r.sent).toBe(1);
    // Abmeldung = Widerspruch: Lead samt Verlauf gelöscht, Versandzeilen ohne Bezug/Mailangaben, nur Prüfwert bleibt
    expect(await leadByName("Podologie Eins")).toBeUndefined();
    expect((await f.pool.query("select count(*)::int as n from sales_lead_events where lead_id = $1", [eins.id])).rows[0].n).toBe(0);
    expect((await f.pool.query("select count(*)::int as n from sales_sends where lead_id = $1", [eins.id])).rows[0].n).toBe(0);
    expect((await f.pool.query("select count(*)::int as n from sales_sends where lead_id is null and message_id is not null and sent_at = $1", [new Date(t0.getTime() + 30 * day)])).rows[0].n).toBe(0);
    const bl = await import("./blocklist");
    expect(await bl.isBlocked("eins@praxis.example")).toBe(true);
    expect((await f.pool.query("select count(*)::int as n from sales_blocklist where hash like '%eins%' or reason like '%@%'")).rows[0].n).toBe(0);
    expect(auditCalls().some((a) => a.action === "vertrieb.unsubscribe" && a.entityId === eins.id)).toBe(true);
    const again = await v.importLeads(admin, "name,email\nPodologie Eins neu,EINS@praxis.example\n", "Messe Test 2026");
    expect(again).toEqual({ imported: 0, skipped: 1 });
  });

  it("Versandfehler wird protokolliert, Schritt bleibt", async () => {
    const id = await v.createLead(admin, { name: "Fehlerpraxis", contactPerson: null, email: "fehler@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null });
    await v.recordLeadConsent(admin, id, "Messe Test, Formular");
    const failing: MailPort = { kind: "smtp", isMock: false, source: "platform", send: async (_m: MailMessage) => Promise.reject(new MailSendError("SMTP-Server nicht erreichbar.", "ECONNECTION")) };
    const r = await v.sendNextMails(admin, [id], { port: failing, now: () => t0, env });
    expect(r.sent).toBe(0);
    expect(r.failed).toEqual([{ name: "Fehlerpraxis", error: "SMTP-Server nicht erreichbar." }]);
    expect(await leadByName("Fehlerpraxis")).toMatchObject({ step: 0, status: "neu" });
    expect((await f.pool.query("select ok, error from sales_sends where lead_id = $1", [id])).rows).toEqual([{ ok: false, error: "SMTP-Server nicht erreichbar." }]);
  });

  it("Tageslimit gilt über alle Klicks; Testmodus in Produktion wird abgelehnt", async () => {
    const lead = await leadByName("Fehlerpraxis");
    const now = new Date();
    await f.pool.query(`insert into sales_sends (step, ok, sent_at) select 1, true, $1 from generate_series(1, ${MAX_PER_DAY})`, [now]);
    const port = new MockMailAdapter();
    const r = await v.sendNextMails(admin, [lead.id], { port, now: () => now, env });
    expect(r.sent).toBe(0);
    expect(port.sent).toHaveLength(0);
    expect((await v.previewSend([lead.id], { now, env })).skipped[0].reason).toMatch(/Tageslimit/);
    await expect(v.sendNextMails(admin, [lead.id], { port, now: () => now, env: { ...env, NODE_ENV: "production" } })).rejects.toThrow(/Produktion/);
  });

  it("Liste mit Filter/Suche, Zähler, manuelle Sperre und Bearbeiten", async () => {
    const id = (await leadByName("Fehlerpraxis")).id;
    await v.updateLead(admin, id, { name: "Fehlerpraxis", contactPerson: "Herr Test", email: "Fehler@Praxis.example", phone: null, website: null, street: null, zip: "99999", city: "Teststadt", distanceKm: 4.2, source: "OpenStreetMap", notes: null });
    expect(await leadByName("Fehlerpraxis")).toMatchObject({ email: "fehler@praxis.example", city: "Teststadt", consent_note: "Messe Test, Formular" });
    expect((await v.listLeads({ q: "teststadt" })).map((l) => l.name)).toEqual(["Fehlerpraxis"]);
    expect((await v.listLeads({ q: "100%_" })).length).toBe(0);
    expect((await v.listLeads({ status: "geantwortet" })).map((l) => l.name)).toEqual(["Podologie Zwei"]);
    await expect(v.updateLead(admin, id, { name: "X", contactPerson: null, email: "zwei@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null })).rejects.toThrow(/bereits/);
    const before = (await v.listSuppressions()).count;
    await v.addSuppression(admin, " FEHLER@praxis.example ");
    // Widerspruch: Eintrag gelöscht, nur Prüfwert (die Konsole zeigt keine Adressen)
    expect(await v.listLeads({ q: "Fehlerpraxis" })).toEqual([]);
    const ov = await v.listSuppressions();
    expect(ov.count).toBe(before + 1);
    expect(ov.recent[0]).toMatchObject({ reason: "widerspruch" });
    // manuell „abgemeldet“ löscht ebenfalls
    const ab = await v.createLead(admin, { name: "Abmelde-Test", contactPerson: null, email: "ab@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null });
    expect(await v.setLeadStatus(admin, ab, "abgemeldet")).toBe("deleted");
    expect(await v.getLead(ab)).toBeNull();
    expect(await (await import("./blocklist")).isBlocked("ab@praxis.example")).toBe(true);
    expect(auditCalls().map((a) => a.action)).toEqual(expect.arrayContaining(["vertrieb.lead_updated", "vertrieb.suppression_added"]));
  });
  // ───────────── Praxissuche (OpenStreetMap, nachts) – gemocktes Netz, keine echten Abrufe ─────────────
  describe("Praxissuche", () => {
    let ls: typeof import("./lead-search");
    const center = { lat: 52.4, lon: 13.0 };
    const at = (km: number) => ({ lat: center.lat + km / 111.195, lon: center.lon });
    const el = (id: number, km: number, tags: Record<string, string>) => ({ type: "node", id, ...at(km), tags: { healthcare: "podiatrist", ...tags } });
    const overpassJson = {
      elements: [
        el(1, 2, { name: "Podologie Ost", email: "info@ost-podo.example", "addr:postcode": "14467", "addr:city": "Potsdam" }),
        el(2, 3, { name: "Fußpflege Kern", email: "christine.kern@kern-fuss.example", website: "kern-fuss.example" }),
        el(3, 4, { name: "Podologie Robots", website: "https://robots-podo.example/" }),
        el(4, 5, { name: "Podologie Schutz", website: "https://schutz-podo.example/" }),
        el(5, 6, { name: "Podologie Doppelt", email: "INFO@Bestand-Podo.example" }),
        el(6, 7, { name: "Podologie Gesperrt", email: "info@gesperrt-podo.example" }),
        el(7, 8, { name: "Podologie Zwei", "addr:postcode": "22222" }),
        el(8, 9, { name: "Nagelstudio", shop: "beauty", beauty: "nails", healthcare: "" }),
        el(10, 9.5, { name: "Podologie Petra Lang", website: "https://lang-podo.example/" }),
        el(11, 9.6, { name: "Podologie Facebook", website: "https://www.facebook.com/podo" }),
        el(9, 15, { name: "Podologie Weit", email: "praxis@weit-podo.example" }),
      ],
    };
    const html = (body: string, status = 200) => new Response(`<html><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    const txt = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
    const pages: Record<string, () => Response> = {
      "https://kern-fuss.example/robots.txt": () => txt("User-agent: *\nDisallow: /intern/"),
      "https://kern-fuss.example/": () => html(`<h1>Fußpflege Kern</h1><a href="/impressum">Impressum</a>`),
      "https://kern-fuss.example/impressum": () => html(`Inhaberin: christine.kern@kern-fuss.example<br>Praxis: praxis [at] kern-fuss [dot] example<br>Webdesign: info@webagentur.example`),
      "https://robots-podo.example/robots.txt": () => txt("User-agent: *\nDisallow: /"),
      "https://schutz-podo.example/robots.txt": () => txt("", 404),
      "https://schutz-podo.example/": () => html("<title>Just a moment...</title>", 403),
      "https://lang-podo.example/robots.txt": () => txt("", 404),
      "https://lang-podo.example/": () => html(`Kontakt: praxis.petra@lang-podo.example · Gestaltung: info@webagentur.example`),
    };
    const requested: string[] = [];
    const webFetch = async (u: string) => {
      requested.push(u);
      const p = pages[u];
      if (!p) throw new Error(`Unerwarteter Abruf ${u}`);
      return p();
    };
    let overpassCalls = 0;
    const overpassFetch = async () => (overpassCalls++, new Response(JSON.stringify(overpassJson), { headers: { "content-type": "application/json" } }));
    const deps = { overpassFetch, webFetch, resolver: async () => [{ address: "93.184.216.34" }], sleep: async () => {}, llm: null };
    const settings = (x: Partial<{ enabled: boolean; centerText: string; resetProgress: boolean; allowNamed: boolean }> = {}) => ({ enabled: true, centerText: "52.4, 13.0", ringKm: 10, maxKm: 20, resetProgress: false, allowNamed: true, ...x });
    const osmLeads = async () => (await f.pool.query("select name, email, website, zip, city, distance_km, source, status, contact_person, phone from sales_leads where source like 'osm%' order by distance_km")).rows;
    const row = (name: string, email: string | null, website: string | null, km: number, source = "osm", zip: string | null = null, city: string | null = null) => ({ name, email, website, zip, city, distance_km: km, source, status: "neu", contact_person: null, phone: null });

    beforeAll(async () => {
      ls = await import("./lead-search");
      const bl = await import("./blocklist");
      const { db } = await import("@/db");
      await bl.addToBlocklist(db, "info@gesperrt-podo.example", "abgemeldet");
      await f.pool.query("insert into sales_leads (name, email, source) values ('Praxis Bestand', 'info@bestand-podo.example', 'manuell')");
    });

    it("ohne Startort/ausgeschaltet läuft nichts", async () => {
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "disabled" });
      expect(await ls.runLeadSearch({ trigger: "manual", adminUserId: admin }, deps)).toEqual({ status: "no_center" });
      await expect(ls.saveLeadSearchSettings(admin, settings({ centerText: "" }))).rejects.toThrow(/Startort/);
      await ls.saveLeadSearchSettings(admin, settings({ enabled: false }), { geocode: async () => null });
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "disabled" });
      expect(overpassCalls).toBe(0);
      expect((await v.getSalesSettings()).senderEmail).toBe("max@podo.example");
      expect((await ls.getLeadSearch()).runningSince).toBeNull();
    });

    it("erster Ring: Funktions-/Geschäftsadressen, Dubletten/Sperrliste, robots/Challenge, keine Fremddomains von der Website", async () => {
      await ls.saveLeadSearchSettings(admin, settings());
      const before = await leadByName("Podologie Zwei");
      const r = await ls.runLeadSearch({ trigger: "cron" }, deps);
      expect(r).toMatchObject({ status: "ok", run: { innerKm: 0, outerKm: 10, found: 9, added: 6, withEmail: 3, named: 1, duplicates: 3, crawled: 4 } });
      expect(overpassCalls).toBe(1);
      expect(await osmLeads()).toEqual([
        row("Podologie Ost", "info@ost-podo.example", null, 2, "osm", "14467", "Potsdam"),
        row("Fußpflege Kern", "praxis@kern-fuss.example", "https://kern-fuss.example/", 3, "osm+impressum"),
        row("Podologie Robots", null, "https://robots-podo.example/", 4),
        row("Podologie Schutz", null, "https://schutz-podo.example/", 5),
        row("Podologie Petra Lang", "praxis.petra@lang-podo.example", "https://lang-podo.example/", 9.5, "osm+impressum"),
        row("Podologie Facebook", null, "https://www.facebook.com/podo", 9.6),
      ]);
      expect((await leadByName("Podologie Petra Lang")).notes).toMatch(/^Adresse mit Namensbezug/);
      expect((await leadByName("Fußpflege Kern")).notes).toMatch(/^Automatisch gefunden \(OpenStreetMap node\/2/);
      // robots.txt verbietet alles → nur robots.txt; 403-Challenge → keine weitere Seite; Facebook wird nicht abgerufen
      expect(requested).toEqual([
        "https://kern-fuss.example/robots.txt",
        "https://kern-fuss.example/",
        "https://kern-fuss.example/impressum",
        "https://robots-podo.example/robots.txt",
        "https://schutz-podo.example/robots.txt",
        "https://schutz-podo.example/",
        "https://lang-podo.example/robots.txt",
        "https://lang-podo.example/",
      ]);
      expect((await f.pool.query("select * from sales_leads where name = 'Podologie Zwei'")).rows).toEqual([before]);
      expect(await ls.getLeadSearch()).toMatchObject({ doneKm: 10, runningSince: null, ringFailures: 0, lastRun: { added: 6, outerKm: 10, manual: false } });
      expect(auditCalls().some((a) => a.action === "vertrieb.lead_search")).toBe(true);
    });

    it("zweiter Ring mit LLM-Auswahl; ältere Leads ohne E-Mail werden nachträglich ergänzt (nie bearbeitete, nur leere E-Mail)", async () => {
      pages["https://schutz-podo.example/"] = () => html(`<a href="mailto:info@schutz-podo.example">Mail</a>`);
      // bearbeiteter Lead ohne E-Mail bleibt unangetastet
      await f.pool.query("update sales_leads set updated_at = created_at + interval '1 hour' where name = 'Podologie Robots'");
      requested.length = 0;
      const llm = { choosePracticeEmail: vi.fn(async () => ({ best: null, personal: ["praxis@weit-podo.example"] })) };
      const r = await ls.runLeadSearch({ trigger: "manual", adminUserId: admin }, { ...deps, llm });
      expect(r).toMatchObject({ status: "ok", run: { innerKm: 10, outerKm: 20, found: 1, added: 1, withEmail: 0, enriched: 1, manual: true } });
      expect(llm.choosePracticeEmail).toHaveBeenCalledWith("Podologie Weit", ["praxis@weit-podo.example"]);
      expect(await leadByName("Podologie Weit")).toMatchObject({ email: null, distance_km: 15 });
      expect(await leadByName("Podologie Schutz")).toMatchObject({ email: "info@schutz-podo.example", source: "osm+impressum" });
      expect(requested).not.toContain("https://robots-podo.example/robots.txt");
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "finished" });
      // von vorn: alles schon vorhanden → nichts Neues
      await ls.saveLeadSearchSettings(admin, settings({ resetProgress: true }));
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toMatchObject({ status: "ok", run: { added: 0 } });
    });

    it("Overpass-Fehler: Ring nicht weitergezählt, nach 3 Fehlschlägen halbe Ringbreite; paralleler Lauf abgewiesen", async () => {
      const s0 = await ls.getLeadSearch();
      const failing = { ...deps, overpassFetch: async () => new Response("busy", { status: 429 }) };
      for (let i = 0; i < 3; i++) {
        const r = await ls.runLeadSearch({ trigger: "cron" }, failing);
        expect(r).toMatchObject({ status: "error", run: { error: expect.stringMatching(/ausgelastet/) } });
      }
      const s1 = await ls.getLeadSearch();
      expect(s1).toMatchObject({ doneKm: s0.doneKm, ringFailures: 3, runningSince: null });
      const tooMany = { ...deps, overpassFetch: async () => new Response(JSON.stringify({ elements: Array.from({ length: 2000 }, () => ({})) })) };
      expect(await ls.runLeadSearch({ trigger: "cron" }, tooMany)).toMatchObject({ status: "error", run: { outerKm: s0.doneKm + 5, error: expect.stringMatching(/2000/) } });
      await f.pool.query("update sales_settings set lead_search = jsonb_set(lead_search, '{runningSince}', to_jsonb(now()::text)) where id = 1");
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "busy" });
    });

    it("LLM nur mit ausdrücklicher Freigabe und eigener Konfiguration (LEAD_LLM_*)", () => {
      const cfg = { LEAD_LLM_BASE_URL: "https://llm.example/v1", LEAD_LLM_API_KEY: "k", LEAD_LLM_MODEL: "m" };
      expect(ls.llmPickerFromEnv(cfg)).toBeNull();
      expect(ls.llmPickerFromEnv({ LEAD_SEARCH_LLM_APPROVED: "true", LLM_BASE_URL: "https://x.example", LLM_API_KEY: "k", LLM_MODEL: "m" })).toBeNull();
      expect(ls.llmPickerFromEnv({ ...cfg, LEAD_SEARCH_LLM_APPROVED: "true" })).not.toBeNull();
    });
  });
  // ───────────── Pipeline, Kampagnen, Aktionscodes in Mails ─────────────
  describe("Pipeline und Kampagnen", () => {
    let pl: typeof import("./vertrieb-pipeline");
    let promo: typeof import("./promo-codes");
    const sfx = Math.random().toString(36).slice(2, 7);
    const later = new Date(Date.now() + 3 * day); // außerhalb des Tageslimits der vorigen Tests
    const mk = async (name: string, email: string | null, website: string | null = null) => {
      const id = await v.createLead(admin, { name, contactPerson: null, email, phone: null, website, street: null, zip: null, city: "Pipestadt", distanceKm: 3, source: "manuell", notes: null });
      if (email) await v.recordLeadConsent(admin, id, "Anfrage über das Kontaktformular");
      return id;
    };
    const ownerOrg = async (email: string, patch: { plan?: string; status?: string } = {}) => {
      const org = await f.org();
      const u = (await f.pool.query("insert into users (email, name, password_hash) values ($1, 'Inhaberin', 'x') returning id", [email])).rows[0].id;
      await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, u]);
      await f.pool.query("update organizations set plan = $2, subscription_status = $3, trial_ends_at = now() + interval '30 days' where id = $1", [org, patch.plan ?? "trial", patch.status ?? "trialing"]);
      return org;
    };
    const item = async (id: string) => (await pl.loadPipeline()).find((l) => l.id === id)!;

    beforeAll(async () => {
      pl = await import("./vertrieb-pipeline");
      promo = await import("./promo-codes");
      // die Praxissuche-Tests lassen eine laufende Suche zurück – für den Versand egal
    });

    it("Stufen: neu → angeschrieben → Antwort erhalten (Verlauf, Status)", async () => {
      const id = await mk("Pipe Eins", `info@pipe1-${sfx}.example`);
      expect((await item(id)).stage).toBe("neu");
      const port = new MockMailAdapter();
      expect((await v.sendNextMails(admin, [id], { port, now: () => later, env })).sent).toBe(1);
      expect(await item(id)).toMatchObject({ stage: "angeschrieben", step: 1, sendsOk: 1 });
      await pl.addLeadNote(admin, id, "Rückruf Montag");
      await pl.markReplied(admin, id);
      expect(await item(id)).toMatchObject({ stage: "geantwortet", status: "geantwortet" });
      const lead = (await v.getLead(id))!.lead;
      expect(lead.repliedAt).not.toBeNull();
      const tl = await pl.leadTimeline(lead);
      expect(tl.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "send", "note", "reply"]));
      // Antwort beendet die Sequenz
      expect((await v.sendNextMails(admin, [id], { port, now: () => new Date(later.getTime() + 30 * day), env })).sent).toBe(0);
      await expect(pl.addLeadNote(admin, id, "   ")).rejects.toThrow(/leer/);
    });

    it("Test gestartet / Kunde: Registrierung per Domain, E-Mail oder persönlichem Code", async () => {
      const dom = await mk("Pipe Domain", `info@pipe2-${sfx}.example`);
      const web = await mk("Pipe Web", null, `https://www.pipe3-${sfx}.example/`);
      const viaCode = await mk("Pipe Code", `kontakt@gmx.de`);
      const orgDom = await ownerOrg(`anna@pipe2-${sfx}.example`);
      await ownerOrg(`chef@pipe3-${sfx}.example`, { plan: "praxis", status: "active" });
      const orgCode = await ownerOrg(`irgendwer-${sfx}@gmx.de`);
      await promo.createPromoCode(admin, { code: `TPIPE${sfx.toUpperCase()}-L`, label: "persönlich", trialDays: 90, grantPlan: null, maxRedemptions: 1, validUntil: null, campaignId: null, leadId: viaCode });
      await promo.redeemPromoCodeForOrganization(orgCode, admin, `TPIPE${sfx.toUpperCase()}-L`);
      expect(await item(dom)).toMatchObject({ stage: "test", org: { id: orgDom, via: "domain" } });
      expect(await item(web)).toMatchObject({ stage: "kunde", org: { via: "domain", converted: true } });
      expect(await item(viaCode)).toMatchObject({ stage: "test", org: { id: orgCode, via: "code" } });
      const dash = await pl.salesDashboard(await pl.loadPipeline());
      expect(dash.tests).toBeGreaterThanOrEqual(2);
      expect(dash.customers).toBeGreaterThanOrEqual(1);
      expect(dash.redemptions).toBeGreaterThanOrEqual(1);
    });

    it("Sammelaktionen und Filter: Status, Kampagne, Abmelden (Sperrliste)", async () => {
      const a = await mk("Pipe Bulk A", `a@pipe4-${sfx}.example`);
      const b = await mk("Pipe Bulk B", `b@pipe4-${sfx}.example`);
      const camp = await pl.createCampaign(admin, { name: `Herbst ${sfx}`, notes: null });
      expect(await pl.setLeadsCampaign(admin, [a, b, a], camp)).toBe(2);
      expect(await pl.setLeadsCampaign(admin, [a], camp)).toBe(0); // unverändert
      const all = await pl.loadPipeline();
      expect(pl.filterPipeline(all, { campaign: camp }).map((l) => l.name).sort()).toEqual(["Pipe Bulk A", "Pipe Bulk B"]);
      expect(pl.filterPipeline(all, { q: "pipe bulk", email: "ohne" })).toEqual([]);
      expect(pl.filterPipeline(all, { stage: "neu", q: "Pipe Bulk" })).toHaveLength(2);
      expect(await pl.bulkSetStatus(admin, [a], "kein_interesse")).toBe(1);
      expect((await item(a)).stage).toBe("aus");
      expect((await pl.leadTimeline((await v.getLead(b))!.lead)).some((e) => e.kind === "campaign")).toBe(true);
      expect(await pl.bulkSetStatus(admin, [b, "00000000-0000-4000-8000-000000000000"], "abgemeldet")).toBe(1);
      expect(await v.getLead(b)).toBeNull();
      expect(await (await import("./blocklist")).isBlocked(`b@pipe4-${sfx}.example`)).toBe(true);
    });

    it("Kampagne mit {{code}}/{{link}}: ohne gültigen Code übersprungen, mit Code im Text", async () => {
      const id = await mk("Pipe Kampagne", `info@pipe5-${sfx}.example`);
      const camp = await pl.createCampaign(admin, { name: `Code ${sfx}`, notes: null });
      await pl.setLeadsCampaign(admin, [id], camp);
      await expect(pl.saveCampaignTemplates(admin, camp, [{ subject: "x {{falsch}}", body: "y" }, { subject: "a", body: "b" }, { subject: "a", body: "b" }])).rejects.toThrow(/Unbekannte/);
      await pl.saveCampaignTemplates(admin, camp, [
        { subject: "3 Monate gratis: {{code}}", body: "{{anrede}},\nhier testen: {{link}}" },
        { subject: "Mail 2", body: "Text" },
        { subject: "Mail 3", body: "Text" },
      ]);
      const pre = await v.previewSend([id], { now: later, env });
      expect(pre.count).toBe(0);
      expect(pre.skipped[0].reason).toMatch(/Aktionscode/);
      const port = new MockMailAdapter();
      expect(await v.sendNextMails(admin, [id], { port, now: () => later, env })).toMatchObject({ sent: 0, skipped: 1 });
      const code = `TPIPE${sfx.toUpperCase()}-K`;
      await promo.createPromoCode(admin, { code, label: "Kampagne", trialDays: 90, grantPlan: null, maxRedemptions: null, validUntil: new Date(Date.now() + 90 * day), campaignId: camp });
      const pre2 = await v.previewSend([id], { now: later, env });
      expect(pre2.first).toMatchObject({ subject: `3 Monate gratis: ${code}` });
      expect(pre2.first!.text).toContain(`https://podo.example/aktion/${code}`);
      expect((await v.sendNextMails(admin, [id], { port, now: () => later, env })).sent).toBe(1);
      expect(port.sent[0].text).toContain(`https://podo.example/aktion/${code}`);
      const stats = (await pl.campaignStats(await pl.loadPipeline(), [camp])).get(camp)!;
      expect(stats).toMatchObject({ leads: 1, contacted: 1, sent: 1, tests: 0, codes: [{ code, active: true }] });
      // Code einer Praxis eingelöst → Test in der Kampagnen-Statistik
      const o = await ownerOrg(`x-${sfx}@gmx.de`);
      await promo.redeemPromoCodeForOrganization(o, admin, code);
      expect((await pl.campaignStats(await pl.loadPipeline(), [camp])).get(camp)).toMatchObject({ tests: 1, converted: 0 });
      // Einwilligung gilt für die Adresse: neue E-Mail → Einwilligung weg, Versand übersprungen
      await v.updateLead(admin, id, { name: "Pipe Kampagne", contactPerson: null, email: `neu@pipe5-${sfx}.example`, phone: null, website: null, street: null, zip: null, city: "Pipestadt", distanceKm: 3, source: "manuell", notes: null });
      const after = (await v.getLead(id))!.lead;
      expect(after).toMatchObject({ consentAt: null, consentNote: null });
      expect((await pl.leadTimeline(after)).some((e) => e.kind === "consent")).toBe(true);
      // zurück auf Standardvorlagen
      await pl.saveCampaignTemplates(admin, camp, null);
      expect(pl.campaignTemplates((await pl.getCampaign(camp))!)).toBeNull();
    });
  
    it("Speicherdauer: Leads ohne Kontakt seit 24 Monaten werden gelöscht, Kunden und aktive bleiben", async () => {
      const stale = await mk("Pipe Alt", `alt@pipe6-${sfx}.example`);
      const fresh = await mk("Pipe Frisch", `frisch@pipe6-${sfx}.example`);
      const kunde = await mk("Pipe Kunde", `kunde@pipe6-${sfx}.example`);
      await f.pool.query("update sales_leads set status = 'kunde' where id = $1", [kunde]);
      await f.pool.query("delete from sales_lead_events where lead_id = any($1)", [[stale, kunde]]);
      await f.pool.query("update sales_leads set created_at = now() - interval '25 months', updated_at = now() - interval '25 months', consent_at = now() - interval '25 months' where id = any($1)", [[stale, kunde]]);
      // ohne Einwilligung schon nach 12 Monaten, mit Einwilligung erst nach 24
      const noConsent = await mk("Pipe Ohne", null);
      const withConsent13 = await mk("Pipe Mit13", `mit13@pipe6-${sfx}.example`);
      await f.pool.query("delete from sales_lead_events where lead_id = any($1)", [[noConsent, withConsent13]]);
      await f.pool.query("update sales_leads set created_at = now() - interval '13 months', updated_at = now() - interval '13 months', consent_at = case when consent_at is null then null else now() - interval '13 months' end where id = any($1)", [[noConsent, withConsent13]]);
      await promo.createPromoCode(admin, { code: `TPIPE${sfx.toUpperCase()}-P`, label: "Pipe Ohne", trialDays: 90, grantPlan: null, maxRedemptions: 1, validUntil: null, campaignId: null, leadId: noConsent });
      expect(await v.purgeStaleLeads()).toBeGreaterThanOrEqual(2);
      expect((await f.pool.query("select label from promo_codes where code = $1", [`TPIPE${sfx.toUpperCase()}-P`])).rows[0].label).toBe("(gelöscht)");
      expect(await v.getLead(stale)).toBeNull();
      expect(await v.getLead(noConsent)).toBeNull();
      expect(await v.getLead(withConsent13)).not.toBeNull();
      expect(await v.getLead(fresh)).not.toBeNull();
      expect(await v.getLead(kunde)).not.toBeNull();
    });

    it("Abmeldung sperrt auch Website und Name+PLZ; persönlicher Code anonymisiert; Kunde mit gesperrter Adresse bearbeitbar", async () => {
      const id = await v.createLead(admin, { name: `Pipe Weg ${sfx}`, contactPerson: null, email: `weg@pipe7-${sfx}.example`, phone: null, website: `https://www.pipe7-${sfx}.example/`, street: null, zip: "12345", city: "Pipestadt", distanceKm: 3, source: "manuell", notes: null });
      await promo.createPromoCode(admin, { code: `TPIPE${sfx.toUpperCase()}-W`, label: `Pipe Weg ${sfx}`, trialDays: 90, grantPlan: null, maxRedemptions: 1, validUntil: null, campaignId: null, leadId: id });
      expect(await v.setLeadStatus(admin, id, "abgemeldet")).toBe("deleted");
      expect((await f.pool.query("select label, lead_id from promo_codes where code = $1", [`TPIPE${sfx.toUpperCase()}-W`])).rows[0]).toEqual({ label: "(gelöscht)", lead_id: null });
      expect((await f.pool.query("select kind from sales_blocklist where created_at > now() - interval '1 minute' order by kind")).rows.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(["email", "host", "namezip"]));
      // gleiche Praxis mit anderer Adresse: Import überspringt (Website bzw. Name+PLZ)
      const csv = [`name;email;website;zip;city`, `Pipe Weg ${sfx};neu@anders-${sfx}.example;;12345;Pipestadt`, `Andere Praxis ${sfx};x@y-${sfx}.example;https://pipe7-${sfx}.example;99999;Ort`].join("\n");
      const pre = await v.previewImport(csv);
      expect(pre.newCount).toBe(0);
      expect(pre.decisions.map((d) => (d.action === "übersprungen" ? d.reason : d.action))).toEqual([expect.stringMatching(/abgemeldet/), expect.stringMatching(/abgemeldet/)]);
      // Anlegen von Hand: Website bzw. Name+PLZ der abgemeldeten Praxis abgelehnt
      const base = { contactPerson: null, phone: null, street: null, city: "Pipestadt", distanceKm: 3, source: "manuell", notes: null };
      await expect(v.createLead(admin, { ...base, name: `Neu ${sfx}`, email: `neu1@x-${sfx}.example`, website: `https://pipe7-${sfx}.example`, zip: "99999" })).rejects.toThrow(/Website/);
      await expect(v.createLead(admin, { ...base, name: `Pipe Weg ${sfx}`, email: `neu2@x-${sfx}.example`, website: null, zip: "12345" })).rejects.toThrow(/Name und PLZ/);
      const okId = await v.createLead(admin, { ...base, name: `Neu ${sfx}`, email: `neu3@x-${sfx}.example`, website: null, zip: "99999" });
      await expect(v.updateLead(admin, okId, { ...base, name: `Neu ${sfx}`, email: `neu3@x-${sfx}.example`, website: `https://www.pipe7-${sfx}.example/`, zip: "99999" })).rejects.toThrow(/Website/);
      // gelöschter Lead (manuell bzw. Löschlauf): persönlicher Code anonymisiert
      await promo.createPromoCode(admin, { code: `TPIPE${sfx.toUpperCase()}-D`, label: `Neu ${sfx}`, trialDays: 90, grantPlan: null, maxRedemptions: 1, validUntil: null, campaignId: null, leadId: okId });
      await v.deleteLead(admin, okId);
      expect((await f.pool.query("select label from promo_codes where code = $1", [`TPIPE${sfx.toUpperCase()}-D`])).rows[0].label).toBe("(gelöscht)");
      // Kunde mit gesperrter Adresse (Widerspruch) bleibt bearbeitbar, solange die Adresse gleich bleibt
      const k = await v.createLead(admin, { name: `Pipe Kunde2 ${sfx}`, contactPerson: null, email: `k2@pipe7-${sfx}.example`, phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: "manuell", notes: null });
      await v.setLeadStatus(admin, k, "kunde");
      await v.addSuppression(admin, `k2@pipe7-${sfx}.example`);
      await expect(v.updateLead(admin, k, { name: `Pipe Kunde2 ${sfx} GmbH`, contactPerson: null, email: `K2@pipe7-${sfx}.example`, phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: "manuell", notes: null })).resolves.toBeUndefined();
    });

    it("Kanarienwert: anderer Sperrlisten-Schlüssel sperrt Versand, Import und Praxissuche (fail-closed)", async () => {
      const id = await mk("Pipe Kanarie", `kanarie@pipe8-${sfx}.example`);
      const savedRow = (await f.pool.query("select to_jsonb(s) as j from sales_settings s where id = 1")).rows[0].j;
      const saved = savedRow.blocklist_key_check;
      expect(saved).toMatch(/^v1:[0-9a-f]{64}$/);
      // DB-Trigger (0043): Kanarienwert nach dem ersten Setzen weder änderbar noch auf NULL zu setzen
      await expect(f.pool.query("update sales_settings set blocklist_key_check = 'v1:' || repeat('0', 64) where id = 1")).rejects.toThrow(/unveränderbar/);
      await expect(f.pool.query("update sales_settings set blocklist_key_check = null where id = 1")).rejects.toThrow(/unveränderbar/);
      await f.pool.query("update sales_settings set sender_name = sender_name where id = 1");
      // Schlüsseltausch simulieren: Zeile mit fremdem Kanarienwert neu anlegen
      await f.pool.query("delete from sales_settings where id = 1");
      await f.pool.query("insert into sales_settings select * from jsonb_populate_record(null::sales_settings, $1::jsonb || jsonb_build_object('blocklist_key_check', 'v1:' || repeat('0', 64)))", [JSON.stringify(savedRow)]);
      try {
        await expect(v.sendNextMails(admin, [id], { port: new MockMailAdapter(), now: () => later, env })).rejects.toThrow(/Sperrlisten-Schlüssel passt nicht/);
        expect((await v.previewSend([id], { now: later, env })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/Sperrlisten-Schlüssel/)]));
        expect(await v.importLeads(admin, "name,email\nX,x@kanarie.example\n", "Test")).toMatchObject({ imported: 0, error: expect.stringMatching(/Sperrlisten-Schlüssel/) });
        await expect(v.createLead(admin, { name: "Kanarie neu", contactPerson: null, email: null, phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null })).rejects.toThrow(/Sperrlisten-Schlüssel/);
        const ls = await import("./lead-search");
        await expect(ls.runLeadSearch({ trigger: "manual", adminUserId: admin })).rejects.toThrow(/Sperrlisten-Schlüssel/);
      } finally {
        await f.pool.query("delete from sales_settings where id = 1");
        await f.pool.query("insert into sales_settings select * from jsonb_populate_record(null::sales_settings, $1::jsonb)", [JSON.stringify(savedRow)]);
      }
    });

    it("ohne bestätigten Versanddienstleister kein Versand", async () => {
      const s = await v.getSalesSettings();
      expect(v.settingsProblems({ ...s, mailProcessorConfirmed: false }, env)).toEqual(expect.arrayContaining([expect.stringMatching(/Versanddienstleister/)]));
      expect(v.settingsProblems({ ...s, mailProcessorConfirmed: true }, env).some((x) => /Versanddienstleister/.test(x))).toBe(false);
    });
});
});
