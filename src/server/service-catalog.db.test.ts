/**
 * Leistungs-Katalog gegen eine echte DB (RLS aktiv, erfundene Daten): eigene Kategorien (CRUD, Mandantentrennung,
 * Löschen nur leer, Art folgt der Kategorie), Archivieren gibt das Kürzel frei (mit Kollision), alte Rechnungen bleiben
 * unverändert, Reihenfolge „häufig gebucht“; letzte Prüfrunde: Trigger-Race, Trigger-Härtung, _archiv-Kürzel abgelehnt,
 * Gutschriften nicht gezählt, Audit-Felder, Startkategorien nur beim Anlegen der Praxis (nicht beim Lesen).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Leistungs-Katalog (DB)", () => {
  const f = fixtures(TEST_DB!);
  let mod: typeof import("./service-catalog");
  let orgA: string;
  let orgB: string;
  let user: string;

  const auth = (org: string, perms = ["settings.manage"]) =>
    ({ role: "owner", support: null, organization: { id: org }, user: { id: user }, can: (p: string) => perms.includes(p) }) as unknown as AuthContext;
  const q = <T = Record<string, unknown>>(org: string, sql: string, params: unknown[] = []) => f.asOrg(org, async (c) => (await c.query(sql, params)).rows as T[]);
  const addService = async (org: string, code: string, name: string, category = "treatment") =>
    (await q<{ id: string }>(org, "insert into services (organization_id, code, name, price_cents, category) values ($1,$2,$3,5000,$4) returning id", [org, code, name, category]))[0].id;
  const service = async (org: string, id: string) =>
    (await q<{ code: string; active: boolean; category: string; category_id: string }>(org, "select code, active, category, category_id from services where id = $1", [id]))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./service-catalog");
    orgA = await f.org();
    orgB = await f.org();
    user = await f.user();
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("neue Leistung ohne Kategorie bekommt per Trigger die Kategorie ihrer Art", async () => {
    const id = await addService(orgA, "WG", "Wegegeld", "travel");
    const s = await service(orgA, id);
    const [cat] = await q<{ name: string; kind: string }>(orgA, "select name, kind from service_categories where id = $1", [s.category_id]);
    expect(cat).toEqual({ name: "Hausbesuch & Wegegeld", kind: "travel" });
  });

  it("Kategorien: anlegen, umbenennen, sortieren; Namen eindeutig je Praxis; fremde Praxis sieht nichts", async () => {
    const { id } = await mod.createServiceCategory(auth(orgA), { name: "Fußpflege kosmetisch", kind: "cosmetic" });
    await expect(mod.createServiceCategory(auth(orgA), { name: "Fußpflege kosmetisch" })).rejects.toThrow(/gibt es schon/);
    // gleicher Name in einer anderen Praxis ist erlaubt
    await expect(mod.createServiceCategory(auth(orgB), { name: "Fußpflege kosmetisch" })).resolves.toHaveProperty("id");
    await mod.renameServiceCategory(auth(orgA), id, "Kosmetik");
    // fremde Praxis kann die Kategorie weder umbenennen noch löschen (RLS + Mandanten-Bedingung)
    await expect(mod.renameServiceCategory(auth(orgB), id, "Gekapert")).rejects.toThrow(/nicht gefunden/);
    await expect(mod.deleteServiceCategory(auth(orgB), id)).rejects.toThrow(/nicht gefunden/);
    const listA = await f.asOrg(orgA, async () => null).then(() => q<{ id: string; name: string }>(orgA, "select id, name from service_categories order by sort, name"));
    expect(listA.map((c) => c.name)).toContain("Kosmetik");
    const listB = await q<{ id: string }>(orgB, "select id from service_categories where id = $1", [id]);
    expect(listB).toEqual([]);
    // nach oben schieben
    const before = await q<{ id: string }>(orgA, "select id from service_categories order by sort, name");
    await mod.moveServiceCategory(auth(orgA), id, -1);
    const after = await q<{ id: string }>(orgA, "select id from service_categories order by sort, name");
    expect(after.findIndex((c) => c.id === id)).toBe(before.findIndex((c) => c.id === id) - 1);
    // ohne Recht: verweigert
    await expect(mod.createServiceCategory(auth(orgA, []), { name: "X" })).rejects.toThrow();
  });

  it("Löschen nur leer; vorher verschieben – die Art der Leistungen folgt der Ziel-Kategorie", async () => {
    const { id: brace } = await mod.createServiceCategory(auth(orgA), { name: "Spangen extra", kind: "brace" });
    const { id: target } = await mod.createServiceCategory(auth(orgA), { name: "Behandlung extra", kind: "treatment" });
    const sid = await addService(orgA, "SX", "Spange X", "treatment");
    await q(orgA, "update services set category_id = $2 where id = $1", [sid, brace]);
    expect((await service(orgA, sid)).category).toBe("brace");
    const listed = await f.asOrg(orgA, async () => null).then(async () => {
      const { withOrg } = await import("@/db");
      return withOrg(orgA, (tx) => mod.listServiceCategories(tx, orgA));
    });
    expect(listed.find((c) => c.id === brace)?.count).toBe(1);
    await expect(mod.deleteServiceCategory(auth(orgA), brace)).rejects.toThrow(/noch 1 Leistung/);
    expect(await mod.moveServicesToCategory(auth(orgA), brace, target)).toBe(1);
    expect(await service(orgA, sid)).toMatchObject({ category_id: target, category: "treatment" });
    await mod.deleteServiceCategory(auth(orgA), brace);
    expect(await q(orgA, "select 1 from service_categories where id = $1", [brace])).toEqual([]);
    // Kategorie einer fremden Praxis lässt sich nicht zuweisen (Trigger)
    const [foreign] = await q<{ id: string }>(orgB, "select id from service_categories limit 1");
    await expect(q(orgA, "update services set category_id = $2 where id = $1", [sid, foreign.id])).rejects.toThrow();
  });

  it("Archivieren gibt das Kürzel frei (mit Kollision), Wiederherstellen gibt es zurück oder meldet die Belegung", async () => {
    const first = await addService(orgA, "AN", "Anamnesegespräch");
    // Rechnung mit dieser Leistung: Bezeichnung als Kopie in der Position
    const [inv] = await q<{ id: string }>(orgA, "insert into invoices (organization_id, status) values ($1,'draft') returning id", [orgA]);
    await q(orgA, "insert into invoice_lines (organization_id, invoice_id, service_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'AN · Anamnesegespräch',5000,5000,0,1)", [orgA, inv.id, first]);
    await q(orgA, "update invoices set status='issued', number='T-AN-1', issued_at=current_date, total_cents=5000, net_cents=5000 where id=$1", [inv.id]);

    expect(await mod.setServiceActive(auth(orgA), first, false)).toEqual({ code: "AN_archiv", codeConflict: null });
    // Kürzel ist frei: neue Leistung „AN“, auch sie wird archiviert → AN_archiv2
    const second = await addService(orgA, "AN", "Anamnese neu");
    expect(await mod.setServiceActive(auth(orgA), second, false)).toEqual({ code: "AN_archiv2", codeConflict: null });
    const third = await addService(orgA, "AN", "Anamnese dritte");

    // alte Rechnung unverändert (Text der Position ist eine Kopie)
    const [line] = await q<{ description: string }>(orgA, "select description from invoice_lines where invoice_id = $1", [inv.id]);
    expect(line.description).toBe("AN · Anamnesegespräch");

    // Wiederherstellen, während „AN“ belegt ist → bleibt AN_archiv, Hinweis
    expect(await mod.setServiceActive(auth(orgA), first, true)).toEqual({ code: "AN_archiv", codeConflict: "AN" });
    expect(await service(orgA, first)).toMatchObject({ active: true, code: "AN_archiv" });
    // „AN“ wieder frei → zweite Leistung bekommt beim Wiederherstellen ihr Kürzel zurück
    await mod.setServiceActive(auth(orgA), third, false);
    expect(await mod.setServiceActive(auth(orgA), second, true)).toEqual({ code: "AN", codeConflict: null });
  });

  it("Kürzel eines Produkts zählt als belegt (gemeinsame Schnelleingabe)", async () => {
    const sid = await addService(orgA, "PR", "Probe");
    await q(orgA, "insert into products (organization_id, name, code, price_cents) values ($1,'Probeprodukt','PR_ARCHIV',990)", [orgA]);
    expect((await mod.setServiceActive(auth(orgA), sid, false))?.code).toBe("PR_archiv2");
  });

  it("„häufig gebucht“: Termine und Rechnungspositionen der letzten 12 Monate", async () => {
    const org = await f.org();
    const patient = await f.patient(org);
    const rare = await addService(org, "RA", "Ab selten");
    const often = await addService(org, "OF", "Zz oft");
    const old = await addService(org, "OL", "Mm alt");
    const appt = async (svc: string, daysAgo: number, status = "done") => {
      const [a] = await q<{ id: string }>(org, `insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() - make_interval(days => $3), now() - make_interval(days => $3) + interval '30 minutes', $4) returning id`, [org, patient, daysAgo, status]);
      await q(org, "insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)", [org, a.id, svc]);
    };
    await appt(often, 3);
    await appt(often, 40);
    await appt(rare, 5);
    await appt(rare, 6, "cancelled"); // abgesagt zählt nicht
    await appt(old, 500);
    await appt(old, 600); // älter als 12 Monate zählt nicht
    const list = await mod.servicesByUsage(org);
    expect(list.map((s) => s.code)).toEqual(["OF", "RA", "OL"]);
    expect(list.map((s) => s.usage)).toEqual([2, 1, 0]);
    // archivierte erscheinen nicht
    await mod.setServiceActive(auth(org), rare, false);
    expect((await mod.servicesByUsage(org)).map((s) => s.code)).toEqual(["OF", "OL"]);
  });

  it("Trigger: Art passt nicht zur Kategorie → Fehler statt stillem Überschreiben; „Weitere (…)“ nur gleicher Art", async () => {
    const org = await f.org();
    const sid = await addService(org, "TR", "Behandlung T");
    // Art ändern, ohne die Kategorie zu wechseln → Fehler
    await expect(q(org, "update services set category = 'cosmetic' where id = $1", [sid])).rejects.toThrow(/passt nicht zur Kategorie/);
    expect((await service(org, sid)).category).toBe("treatment");
    // gleiche Art erneut setzen ist erlaubt
    await q(org, "update services set category = 'treatment' where id = $1", [sid]);

    // Standardname „Nagelkorrektur“ schon von einer Kategorie anderer Art belegt → „Weitere (Nagelkorrektur)“ der Art brace
    await q(org, "insert into service_categories (organization_id, name, kind) values ($1, 'Nagelkorrektur', 'treatment')", [org]);
    const brace = await addService(org, "BR", "Spange", "brace");
    const [cat] = await q<{ name: string; kind: string }>(org, "select c.name, c.kind from services s join service_categories c on c.id = s.category_id where s.id = $1", [brace]);
    expect(cat).toEqual({ name: "Weitere (Nagelkorrektur)", kind: "brace" });

    // auch „Weitere (Kosmetik & Wellness)“ mit fremder Art belegt → Fehler statt falscher Zuordnung
    await q(org, "insert into service_categories (organization_id, name, kind) values ($1, 'Kosmetik & Wellness', 'treatment'), ($1, 'Weitere (Kosmetik & Wellness)', 'travel')", [org]);
    await expect(addService(org, "KO", "Kosmetik", "cosmetic")).rejects.toThrow(/Keine passende Kategorie/);
  });

  it("Kategorie-Art „Verkauf (alt)“ lässt sich nicht neu anlegen; Verschieben wird protokolliert", async () => {
    const org = await f.org();
    await expect(mod.createServiceCategory(auth(org), { name: "Verkauf neu", kind: "product" })).rejects.toThrow();
    await mod.createServiceCategory(auth(org), { name: "Zuerst", kind: "treatment" });
    const { id } = await mod.createServiceCategory(auth(org), { name: "Zuletzt", kind: "treatment" });
    await mod.moveServiceCategory(auth(org), id, -1);
    const [a] = await q<{ meta: unknown }>(org, "select meta from audit_log where organization_id = $1 and action = 'service_category.move' and entity_id = $2", [org, id]);
    expect(a?.meta).toEqual({ dir: "up" });
  });

  it("Archivieren nimmt Verweise per Kürzel mit; eine neue Leistung mit dem freien Kürzel erbt nichts", async () => {
    const org = await f.org({
      settings: {
        onlineBooking: { enabled: true, serviceCodes: ["VW", "XX"] },
        voice: { serviceCodes: ["VW"] },
        website: { enabled: true, serviceDescriptions: { VW: "Alte Beschreibung" } },
        servicePriceNotes: { VW: "Preis bitte prüfen" },
      },
    });
    const settings = async () => (await f.pool.query("select settings from organizations where id = $1", [org])).rows[0].settings;
    const old = await addService(org, "VW", "Verweis alt");
    await mod.setServiceActive(auth(org), old, false);
    expect(await settings()).toMatchObject({
      onlineBooking: { enabled: true, serviceCodes: ["VW_archiv", "XX"] },
      voice: { serviceCodes: ["VW_archiv"] },
      website: { enabled: true, serviceDescriptions: { VW_archiv: "Alte Beschreibung" } },
      servicePriceNotes: { VW_archiv: "Preis bitte prüfen" },
    });
    // neue Leistung „VW“: kein Verweis zeigt auf sie
    const fresh = await addService(org, "VW", "Verweis neu");
    const s1 = await settings();
    expect(s1.onlineBooking.serviceCodes).not.toContain("VW");
    expect(s1.website.serviceDescriptions.VW).toBeUndefined();
    // Wiederherstellen, während „VW“ belegt ist: Verweise bleiben beim Archiv-Kürzel
    await mod.setServiceActive(auth(org), old, true);
    expect((await settings()).onlineBooking.serviceCodes).toEqual(["VW_archiv", "XX"]);
    // „VW“ frei → Wiederherstellen gibt Kürzel und Verweise zurück
    await mod.setServiceActive(auth(org), fresh, false);
    await mod.setServiceActive(auth(org), old, false);
    await mod.setServiceActive(auth(org), old, true);
    const s2 = await settings();
    expect(s2.onlineBooking.serviceCodes).toEqual(["VW", "XX"]);
    expect(s2.website.serviceDescriptions).toEqual({ VW: "Alte Beschreibung" });
    // aufgeräumte Altverweise beim Anlegen (Liste würde leer → bleibt, denn leer hieße „alle buchbar“)
    await f.pool.query("update organizations set settings = settings || '{\"voice\": {\"serviceCodes\": [\"NEU\"]}, \"servicePriceNotes\": {\"NEU\": \"alt\"}}'::jsonb where id = $1", [org]);
    const { withOrg } = await import("@/db");
    await withOrg(org, (tx) => mod.moveCodeRefsInSettings(tx, org, "NEU", null));
    const s3 = await settings();
    expect(s3.voice.serviceCodes).toEqual(["NEU"]);
    expect(s3.servicePriceNotes).toEqual({});
  });

  it("alle Archiv-Kürzel belegt → verständlicher Fehler, Leistung bleibt aktiv", async () => {
    const org = await f.org();
    const sid = await addService(org, "VO", "Voll");
    await q(org, "insert into services (organization_id, code, name, price_cents, active) select $1, 'VO_archiv' || case when g = 1 then '' else g::text end, 'x', 1, false from generate_series(1, 99) g", [org]);
    await expect(mod.setServiceActive(auth(org), sid, false)).rejects.toThrow(/alle 99 Archiv-Kürzel belegt/);
    expect(await service(org, sid)).toMatchObject({ code: "VO", active: true });
  });

  it("„häufig gebucht“ zählt nicht wahrgenommene Termine nicht; Rechnungen nach Ausstellungsdatum", async () => {
    const org = await f.org();
    const patient = await f.patient(org);
    const a = await addService(org, "NA", "Aa nicht da");
    const b = await addService(org, "RB", "Bb Rechnung");
    for (let i = 0; i < 3; i++) {
      const [ap] = await q<{ id: string }>(org, "insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'no_show') returning id", [org, patient]);
      await q(org, "insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)", [org, ap.id, a]);
    }
    // Rechnung vor langer Zeit angelegt, aber kürzlich ausgestellt → zählt; ausgestellt vor > 12 Monaten → zählt nicht
    for (const [issued, nr] of [["current_date - 10", "U-1"], ["current_date - 500", "U-2"]] as const) {
      const [inv] = await q<{ id: string }>(org, "insert into invoices (organization_id, status, created_at) values ($1,'draft', now() - interval '800 days') returning id", [org]);
      await q(org, "insert into invoice_lines (organization_id, invoice_id, service_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'RB',5000,5000,0,1)", [org, inv.id, b]);
      await q(org, `update invoices set status='issued', number=$2, issued_at=${issued}, total_cents=5000, net_cents=5000 where id=$1`, [inv.id, `${nr}-${org.slice(0, 8)}`]);
    }
    const { withOrg } = await import("@/db");
    const usage = await withOrg(org, (tx) => mod.serviceUsageCounts(tx, org));
    expect(usage.get(a) ?? 0).toBe(0);
    expect(usage.get(b)).toBe(1);
  });

  it("Trigger-Race: gleichzeitig angelegte Leistungen derselben Art landen in derselben Kategorie (kein „Weitere (…)“)", async () => {
    const org = await f.org();
    const c1 = await f.pool.connect();
    const c2 = await f.pool.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query("begin");
        await c.query("select set_config('app.org_id', $1, true)", [org]);
      }
      // c1 legt „Behandlung“ an (noch nicht festgeschrieben); c2 sieht sie noch nicht und wartet am Unique-Index
      await c1.query("insert into services (organization_id, code, name, price_cents) values ($1,'R1','Race 1',100)", [org]);
      const second = c2.query("insert into services (organization_id, code, name, price_cents) values ($1,'R2','Race 2',100) returning category_id", [org]);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("commit");
      const [{ category_id }] = (await second).rows;
      await c2.query("commit");
      const cats = await q<{ id: string; name: string }>(org, "select id, name from service_categories order by name");
      expect(cats.map((c) => c.name)).toEqual(["Behandlung"]);
      expect(category_id).toBe(cats[0].id);
    } finally {
      await c1.query("rollback").catch(() => {});
      await c2.query("rollback").catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it("Trigger gehärtet: fester search_path, feuert auch bei UPDATE OF organization_id", async () => {
    const [fn] = (await f.pool.query("select proconfig from pg_proc where proname = 'services_default_category'")).rows;
    expect(fn.proconfig).toContain("search_path=pg_catalog, public, pg_temp");
    const [tg] = (await f.pool.query("select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'services_default_category'")).rows;
    expect(tg.def).toMatch(/UPDATE OF category_id, category, organization_id/);
  });

  it("Startkategorien: Lesen legt nichts an; neue Praxis bekommt die vier Standardkategorien (wie die Migration)", async () => {
    const { withOrg } = await import("@/db");
    const { seedOrganizationDefaults, seedServiceCategories } = await import("@/lib/org-defaults");
    const empty = await f.org();
    expect(await withOrg(empty, (tx) => mod.listServiceCategories(tx, empty))).toEqual([]);
    expect(await q(empty, "select 1 from service_categories")).toEqual([]);

    const org = await f.org();
    await withOrg(org, (tx) => seedOrganizationDefaults(tx, org));
    const cats = await withOrg(org, (tx) => mod.listServiceCategories(tx, org));
    // vier Standardkategorien; „Verkauf (alt)“ nur, weil der Startkatalog eine Verkaufs-Leistung enthält
    expect(cats.map((c) => [c.name, c.kind])).toEqual([
      ["Behandlung", "treatment"],
      ["Nagelkorrektur", "brace"],
      ["Kosmetik & Wellness", "cosmetic"],
      ["Hausbesuch & Wegegeld", "travel"],
      ["Verkauf (alt)", "product"],
    ]);
    expect(cats.find((c) => c.kind === "treatment")?.count).toBeGreaterThan(0);
    // erneut: keine Dubletten; umbenannte Standardkategorie wird nicht neu angelegt
    await q(org, "update service_categories set name = 'Podologie' where name = 'Behandlung' and organization_id = $1", [org]);
    await withOrg(org, (tx) => seedServiceCategories(tx, org));
    expect((await q(org, "select 1 from service_categories")).length).toBe(5);
  });

  it("Speichern: Kürzel mit „_archiv“ abgelehnt, unverändertes Archiv-Kürzel erlaubt; Audit mit entityId und altem Kürzel", async () => {
    const org = await f.org({ settings: { onlineBooking: { serviceCodes: ["ALT"] } } });
    const { withOrg } = await import("@/db");
    const [cat] = await withOrg(org, async (tx) => {
      const { seedServiceCategories } = await import("@/lib/org-defaults");
      await seedServiceCategories(tx, org);
      return mod.listServiceCategories(tx, org);
    });
    const form = (extra: Record<string, string>) => ({ name: "Testleistung", price: "12,50", vatRate: "0", durationMin: "20", categoryId: cat.id, ...extra });
    for (const code of ["AN_archiv", "an_ARCHIV2", "X_Archiv99"]) {
      expect(await mod.saveService(auth(org), form({ code }))).toEqual({ error: expect.stringMatching(/reserviert/) });
    }
    const created = await mod.saveService(auth(org), form({ code: "alt" }));
    expect(created).toMatchObject({ ok: true, code: "ALT" });
    if (!("ok" in created)) throw new Error("nicht angelegt");
    // Kürzel ändern: Verweise wandern mit, Audit nennt das alte Kürzel
    expect(await mod.saveService(auth(org), form({ id: created.id, code: "neu" }))).toMatchObject({ ok: true, code: "NEU" });
    const logs = await q<{ entity_id: string; meta: Record<string, unknown> }>(org, "select entity_id, meta from audit_log where organization_id = $1 and action = 'service.save' order by id", [org]);
    expect(logs).toEqual([
      { entity_id: created.id, meta: { code: "ALT", created: true } },
      { entity_id: created.id, meta: { code: "NEU", before: "ALT", refsMoved: ["onlineBooking"] } },
    ]);
    // Wiederhergestellt mit belegtem Kürzel: Archiv-Kürzel unverändert speichern geht (Bezeichnung ändern)
    await q(org, "update services set code = 'NEU_archiv' where id = $1", [created.id]);
    expect(await mod.saveService(auth(org), form({ id: created.id, code: "NEU_ARCHIV", name: "Umbenannt" }))).toMatchObject({ ok: true, code: "NEU_archiv" });
    // ohne Recht
    await expect(mod.saveService(auth(org, []), form({ code: "OK" }))).rejects.toThrow();
  });

  it("Wiederherstellen: ungültiges ursprüngliches Kürzel → Archiv-Kürzel bleibt, eigener Hinweis", async () => {
    const org = await f.org();
    const sid = (await q<{ id: string }>(org, "insert into services (organization_id, code, name, price_cents, active) values ($1,'_archiv','Ohne Kürzel',100,false) returning id", [org]))[0].id;
    expect(await mod.setServiceActive(auth(org), sid, true)).toEqual({ code: "_archiv", codeConflict: null, codeInvalid: "" });
    const long = (await q<{ id: string }>(org, "insert into services (organization_id, code, name, price_cents, active) values ($1,'SEHRLANGESK_archiv','Zu lang',100,false) returning id", [org]))[0].id;
    expect(await mod.setServiceActive(auth(org), long, true)).toEqual({ code: "SEHRLANGESK_archiv", codeConflict: null, codeInvalid: "SEHRLANGESK" });
    const [a] = await q<{ meta: unknown }>(org, "select meta from audit_log where organization_id = $1 and action = 'service.unarchive' and entity_id = $2", [org, long]);
    expect(a.meta).toEqual({ code: "SEHRLANGESK_archiv", codeInvalid: "SEHRLANGESK" });
    // langes Kürzel unverändert speichern geht (nur Bezeichnung ändern); ein neues langes Kürzel nicht
    const [{ category_id }] = await q<{ category_id: string }>(org, "select category_id from services where id = $1", [long]);
    const form = (code: string) => ({ id: long, code, name: "Jetzt umbenannt", price: "1,00", vatRate: "0", durationMin: "10", categoryId: category_id });
    expect(await mod.saveService(auth(org), form("SEHRLANGESK_ARCHIV"))).toMatchObject({ ok: true, code: "SEHRLANGESK_archiv" });
    expect(await mod.saveService(auth(org), form("ELFZEICHENX"))).toEqual({ error: "Kürzel höchstens 10 Zeichen." });
  });

  it("Audit: Umbenennen mit altem Namen, Verschieben mit Art vorher/nachher, Archivieren mit mitgewanderten Verweisen", async () => {
    const org = await f.org({ settings: { servicePriceNotes: { AU: "Preis prüfen" } } });
    const { id: from } = await mod.createServiceCategory(auth(org), { name: "Spangen A", kind: "brace" });
    const { id: to } = await mod.createServiceCategory(auth(org), { name: "Kosmetik A", kind: "cosmetic" });
    await mod.renameServiceCategory(auth(org), from, "Spangen B");
    const sid = await addService(org, "AU", "Audit");
    await q(org, "update services set category_id = $2 where id = $1", [sid, from]);
    await mod.moveServicesToCategory(auth(org), from, to);
    await mod.setServiceActive(auth(org), sid, false);
    const meta = async (action: string) => (await q<{ meta: unknown }>(org, "select meta from audit_log where organization_id = $1 and action = $2", [org, action]))[0]?.meta;
    expect(await meta("service_category.rename")).toEqual({ name: "Spangen B", before: "Spangen A" });
    expect(await meta("service_category.move_services")).toEqual({ to, count: 1, fromName: "Spangen B", toName: "Kosmetik A", kindBefore: "brace", kindAfter: "cosmetic" });
    expect(await meta("service.archive")).toEqual({ code: "AU_archiv", before: "AU", refsMoved: ["servicePriceNotes"] });
  });

  it("„häufig gebucht“: Gutschriften zählen nicht", async () => {
    const org = await f.org();
    const sid = await addService(org, "GS", "Gutschrift-Test");
    for (const [kind, nr] of [["invoice", "G-1"], ["credit_note", "G-2"], ["credit_note", "G-3"]] as const) {
      const [inv] = await q<{ id: string }>(org, "insert into invoices (organization_id, status, kind) values ($1,'draft',$2) returning id", [org, kind]);
      await q(org, "insert into invoice_lines (organization_id, invoice_id, service_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'GS',5000,5000,0,1)", [org, inv.id, sid]);
      await q(org, "update invoices set status='issued', number=$2, issued_at=current_date - 3, total_cents=5000, net_cents=5000 where id=$1", [inv.id, `${nr}-${org.slice(0, 8)}`]);
    }
    const { withOrg } = await import("@/db");
    expect((await withOrg(org, (tx) => mod.serviceUsageCounts(tx, org))).get(sid)).toBe(1);
  });

  it("früher archivierte Leistungen: Kürzel nachträglich freigeben (Verweise wandern mit)", async () => {
    const org = await f.org({ settings: { website: { serviceDescriptions: { FA: "Alt" } } } });
    const old = (await q<{ id: string }>(org, "insert into services (organization_id, code, name, price_cents, active) values ($1,'FA','Früh archiviert',100,false) returning id", [org]))[0].id;
    await q(org, "insert into services (organization_id, code, name, price_cents, active) values ($1,'FA_archiv','Schon frei',100,false)", [org]);
    const { withOrg } = await import("@/db");
    expect((await withOrg(org, (tx) => mod.archivedServicesBlockingCodes(tx, org))).map((s) => s.code)).toEqual(["FA"]);
    expect(await mod.releaseArchivedCodes(auth(org))).toEqual({ released: 1, skipped: 0 });
    expect((await service(org, old)).code).toBe("FA_archiv2");
    expect((await f.pool.query("select settings from organizations where id = $1", [org])).rows[0].settings.website.serviceDescriptions).toEqual({ FA_archiv2: "Alt" });
    expect(await withOrg(org, (tx) => mod.archivedServicesBlockingCodes(tx, org))).toEqual([]);
    // Wiederherstellen gibt „FA“ zurück
    expect(await mod.setServiceActive(auth(org), old, true)).toEqual({ code: "FA", codeConflict: null });
  });
});
