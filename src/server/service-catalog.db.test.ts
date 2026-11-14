/**
 * Leistungs-Katalog gegen eine echte DB (RLS aktiv, erfundene Daten): eigene Kategorien (CRUD, Mandantentrennung,
 * Löschen nur leer, Art folgt der Kategorie), Archivieren gibt das Kürzel frei (mit Kollision), alte Rechnungen bleiben
 * unverändert, Reihenfolge „häufig gebucht“.
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
});
