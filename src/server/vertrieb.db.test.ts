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
    await f.pool.query("delete from sales_sends; delete from sales_leads; delete from sales_suppressions; delete from sales_settings");
    admin = await f.user();
  });
  afterAll(async () => {
    await f.pool.query("delete from sales_sends; delete from sales_leads; delete from sales_suppressions; delete from sales_settings");
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("ohne Absender/Impressum wird nicht gesendet", async () => {
    await expect(v.sendNextMails(admin, [], { port: new MockMailAdapter(), env })).rejects.toThrow(/Impressum|Absender/);
  });

  it("Import mit Dubletten und Sperrliste", async () => {
    await f.pool.query("insert into sales_suppressions (email, reason) values ('gesperrt@praxis.example', 'abgemeldet')");
    await v.saveSalesSettings(admin, {
      senderName: "Max Betreiber",
      senderEmail: "max@podo.example",
      replyTo: "",
      impressum: "AlgoVerdict GmbH, Musterstraße 1, 12345 Musterstadt, kontakt@podo.example",
      delay2Days: 5,
      delay3Days: 10,
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
    const r = await v.importLeads(admin, csv);
    expect(r).toEqual({ imported: 2, skipped: 2 });
    expect((await v.importLeads(admin, csv)).imported).toBe(0);
    expect(auditCalls().filter((a) => a.action === "vertrieb.import").map((a) => a.meta)).toEqual([{ imported: 2, skipped: 2 }, { imported: 0, skipped: 4 }]);
    expect(auditCalls().some((a) => a.action === "vertrieb.settings")).toBe(true);
  });

  it("Vorschau zeigt genau die erste Mail; Senden protokolliert, setzt Schritt/Status, Kopfzeilen und Abmeldelink", async () => {
    const eins = await leadByName("Podologie Eins");
    const zwei = await leadByName("Podologie Zwei");
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
    expect(auditCalls().find((a) => a.action === "vertrieb.send")?.meta).toMatchObject({ sent: 2, failed: 0, skipped: 0, mock: true });
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
    expect(await leadByName("Podologie Eins")).toMatchObject({ status: "abgemeldet", step: 3 });
    expect((await f.pool.query("select reason from sales_suppressions where email = 'eins@praxis.example'")).rows).toEqual([{ reason: "abgemeldet" }]);
    // auch nach Statuswechsel zurück auf „neu“ bleibt die Adresse gesperrt (DB-Trigger)
    await f.pool.query("update sales_leads set status = 'neu', step = 0 where id = $1", [eins.id]);
    expect(await leadByName("Podologie Eins")).toMatchObject({ status: "abgemeldet" });
    expect(auditCalls().some((a) => a.action === "vertrieb.unsubscribe" && a.entityId === eins.id)).toBe(true);
    await v.deleteLead(admin, eins.id);
    expect(auditCalls().some((a) => a.action === "vertrieb.lead_deleted" && a.entityId === eins.id)).toBe(true);
    const again = await v.importLeads(admin, "name,email\nPodologie Eins neu,EINS@praxis.example\n");
    expect(again).toEqual({ imported: 0, skipped: 1 });
  });

  it("Versandfehler wird protokolliert, Schritt bleibt", async () => {
    const id = await v.createLead(admin, { name: "Fehlerpraxis", contactPerson: null, email: "fehler@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null });
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
    expect(await leadByName("Fehlerpraxis")).toMatchObject({ email: "fehler@praxis.example", city: "Teststadt" });
    expect((await v.listLeads({ q: "teststadt" })).map((l) => l.name)).toEqual(["Fehlerpraxis"]);
    expect((await v.listLeads({ q: "100%_" })).length).toBe(0);
    expect((await v.listLeads({ status: "geantwortet" })).map((l) => l.name)).toEqual(["Podologie Zwei"]);
    await expect(v.updateLead(admin, id, { name: "X", contactPerson: null, email: "zwei@praxis.example", phone: null, website: null, street: null, zip: null, city: null, distanceKm: null, source: null, notes: null })).rejects.toThrow(/bereits/);
    await v.addSuppression(admin, " FEHLER@praxis.example ");
    const [row] = await v.listLeads({ q: "Fehlerpraxis" });
    expect(row).toMatchObject({ suppressed: true, status: "abgemeldet" });
    expect((await v.statusCounts()).abgemeldet).toBeGreaterThanOrEqual(1);
    expect((await v.listSuppressions()).map((x) => x.email)).toContain("fehler@praxis.example");
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
        el(9, 15, { name: "Podologie Weit", email: "praxis@weit-podo.example" }),
      ],
    };
    const html = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    const pages: Record<string, () => Response> = {
      "https://kern-fuss.example/robots.txt": () => new Response("User-agent: *\nDisallow: /intern/", { headers: { "content-type": "text/plain" } }),
      "https://kern-fuss.example/": () => html(`<h1>Fußpflege Kern</h1><a href="/impressum">Impressum</a>`),
      "https://kern-fuss.example/impressum": () => html(`Inhaberin: christine.kern@kern-fuss.example<br>Praxis: praxis [at] kern-fuss [dot] example`),
      "https://robots-podo.example/robots.txt": () => new Response("User-agent: *\nDisallow: /", { headers: { "content-type": "text/plain" } }),
      "https://schutz-podo.example/robots.txt": () => new Response("", { status: 404 }),
      "https://schutz-podo.example/": () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } }),
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
    const leadsBySource = async () => (await f.pool.query("select name, email, website, zip, city, distance_km, source, status, contact_person, phone from sales_leads where source like 'osm%' order by distance_km")).rows;

    beforeAll(async () => {
      ls = await import("./lead-search");
      await f.pool.query("insert into sales_suppressions (email, reason) values ('info@gesperrt-podo.example', 'abgemeldet') on conflict do nothing");
      await f.pool.query("insert into sales_leads (name, email, source) values ('Praxis Bestand', 'info@bestand-podo.example', 'manuell')");
    });

    it("ohne Startort/ausgeschaltet läuft nichts", async () => {
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "disabled" });
      expect(await ls.runLeadSearch({ trigger: "manual", adminUserId: admin }, deps)).toEqual({ status: "no_center" });
      await expect(ls.saveLeadSearchSettings(admin, { enabled: true, centerText: "", ringKm: 10, maxKm: 20, resetProgress: false })).rejects.toThrow(/Startort/);
      await ls.saveLeadSearchSettings(admin, { enabled: false, centerText: "52.4, 13.0", ringKm: 10, maxKm: 20, resetProgress: false }, { geocode: async () => null });
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "disabled" });
      expect(overpassCalls).toBe(0);
      // Absender-Einstellungen bleiben unverändert
      expect((await v.getSalesSettings()).senderEmail).toBe("max@podo.example");
    });

    it("erster Ring: nur Praxisname + Funktions-E-Mail, Dubletten/Sperrliste übersprungen, robots/Challenge beachtet", async () => {
      await ls.saveLeadSearchSettings(admin, { enabled: true, centerText: "52.4, 13.0", ringKm: 10, maxKm: 20, resetProgress: false });
      const before = await leadByName("Podologie Zwei");
      const r = await ls.runLeadSearch({ trigger: "cron" }, deps);
      expect(r).toMatchObject({ status: "ok", run: { innerKm: 0, outerKm: 10, found: 7, added: 4, withEmail: 2, duplicates: 3, crawled: 3 } });
      expect(overpassCalls).toBe(1);
      expect(await leadsBySource()).toEqual([
        { name: "Podologie Ost", email: "info@ost-podo.example", website: null, zip: "14467", city: "Potsdam", distance_km: 2, source: "osm", status: "neu", contact_person: null, phone: null },
        { name: "Fußpflege Kern", email: "praxis@kern-fuss.example", website: "https://kern-fuss.example/", zip: null, city: null, distance_km: 3, source: "osm+impressum", status: "neu", contact_person: null, phone: null },
        { name: "Podologie Robots", email: null, website: "https://robots-podo.example/", zip: null, city: null, distance_km: 4, source: "osm", status: "neu", contact_person: null, phone: null },
        { name: "Podologie Schutz", email: null, website: "https://schutz-podo.example/", zip: null, city: null, distance_km: 5, source: "osm", status: "neu", contact_person: null, phone: null },
      ]);
      // robots.txt verbietet alles → nur robots.txt; 403-Challenge → keine weitere Seite
      expect(requested).toEqual([
        "https://kern-fuss.example/robots.txt",
        "https://kern-fuss.example/",
        "https://kern-fuss.example/impressum",
        "https://robots-podo.example/robots.txt",
        "https://schutz-podo.example/robots.txt",
        "https://schutz-podo.example/",
      ]);
      // bestehender (manuell gepflegter) Lead unverändert
      expect((await f.pool.query("select * from sales_leads where name = 'Podologie Zwei'")).rows).toEqual([before]);
      const s = await ls.getLeadSearch();
      expect(s).toMatchObject({ doneKm: 10, runningSince: null, lastRun: { added: 4, outerKm: 10, manual: false } });
      expect(auditCalls().some((a) => a.action === "vertrieb.lead_search")).toBe(true);
    });

    it("zweiter Ring mit LLM-Auswahl, dann Ende am Höchstradius", async () => {
      const llm = { choosePracticeEmail: vi.fn(async () => ({ best: null, personal: ["praxis@weit-podo.example"] })) };
      const r = await ls.runLeadSearch({ trigger: "manual", adminUserId: admin }, { ...deps, llm });
      expect(r).toMatchObject({ status: "ok", run: { innerKm: 10, outerKm: 20, found: 1, added: 1, withEmail: 0, manual: true } });
      expect(llm.choosePracticeEmail).toHaveBeenCalledWith("Podologie Weit", ["praxis@weit-podo.example"]);
      expect(await leadByName("Podologie Weit")).toMatchObject({ email: null, distance_km: 15 });
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "finished" });
      // nochmal von vorn: alles schon vorhanden → nichts Neues
      await ls.saveLeadSearchSettings(admin, { enabled: true, centerText: "52.4, 13.0", ringKm: 10, maxKm: 20, resetProgress: true });
      const again = await ls.runLeadSearch({ trigger: "cron" }, deps);
      expect(again).toMatchObject({ status: "ok", run: { added: 0 } });
    });

    it("Overpass-Fehler: Ring wird nicht weitergezählt; paralleler Lauf wird abgewiesen", async () => {
      const s0 = await ls.getLeadSearch();
      const failing = { ...deps, overpassFetch: async () => new Response("busy", { status: 429 }) };
      const r = await ls.runLeadSearch({ trigger: "cron" }, failing);
      expect(r).toMatchObject({ status: "error", run: { error: expect.stringMatching(/ausgelastet/) } });
      expect((await ls.getLeadSearch()).doneKm).toBe(s0.doneKm);
      await f.pool.query("update sales_settings set lead_search = jsonb_set(lead_search, '{runningSince}', to_jsonb(now()::text)) where id = 1");
      expect(await ls.runLeadSearch({ trigger: "cron" }, deps)).toEqual({ status: "busy" });
    });
  });
});
