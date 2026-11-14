import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointmentServices, appointments, invoiceLines, invoices, products, serviceCategories, services } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/assert";
import { audit } from "@/lib/audit";
import { SERVICE_CATEGORIES } from "@/lib/catalog";
import { archivedCodeCandidates, restoredCode } from "@/lib/service-codes";

/**
 * Leistungs-Katalog der Praxis: eigene Kategorien (anlegen, umbenennen, sortieren, löschen), Archivieren mit
 * Kürzel-Freigabe und Reihenfolge nach Häufigkeit („häufig gebucht“).
 * Rechte: Pflege = settings.manage. Alle Abfragen über withOrg (RLS, eigener Mandant).
 */
export class ServiceCatalogError extends Error {}

export type ServiceCategory = typeof serviceCategories.$inferSelect;

export const categoryInput = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen eingeben.").max(60, "Höchstens 60 Zeichen."),
  kind: z.enum(SERVICE_CATEGORIES).default("treatment"),
});

/** Startkategorien (wie die früher festen Kategorien) – für Praxen, die noch keine haben */
export const DEFAULT_SERVICE_CATEGORIES = [
  { name: "Behandlung", kind: "treatment", sort: 10 },
  { name: "Nagelkorrektur", kind: "brace", sort: 20 },
  { name: "Kosmetik & Wellness", kind: "cosmetic", sort: 30 },
  { name: "Hausbesuch & Wegegeld", kind: "travel", sort: 40 },
] as const;

/**
 * Kategorien der Praxis in Anzeige-Reihenfolge, mit Anzahl Leistungen (aktiv + archiviert). Hat die Praxis noch
 * keine (neue Praxis ohne Leistungen), werden die Startkategorien angelegt.
 */
export async function listServiceCategories(tx: Tx, org: string) {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(serviceCategories).where(eq(serviceCategories.organizationId, org));
  if (n === 0) {
    await tx
      .insert(serviceCategories)
      .values(DEFAULT_SERVICE_CATEGORIES.map((c) => ({ ...c, organizationId: org })))
      .onConflictDoNothing();
  }
  return tx
    .select({
      id: serviceCategories.id,
      name: serviceCategories.name,
      kind: serviceCategories.kind,
      sort: serviceCategories.sort,
      // ausdrücklich qualifiziert: in der Unterabfrage würde ein unqualifiziertes "id" auf services zeigen
      count: sql<number>`(select count(*) from services s where s.category_id = "service_categories"."id")`.mapWith(Number),
    })
    .from(serviceCategories)
    .where(eq(serviceCategories.organizationId, org))
    .orderBy(asc(serviceCategories.sort), asc(serviceCategories.name));
}

const uniqueViolation = (e: unknown) => {
  const c = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  return c === "23505";
};

export async function createServiceCategory(auth: AuthContext, input: unknown): Promise<{ id: string }> {
  assertCan(auth, "settings.manage");
  const d = categoryInput.parse(input);
  const org = auth.organization.id;
  try {
    const row = await withOrg(org, async (tx) => {
      const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${serviceCategories.sort}), 0)`.mapWith(Number) }).from(serviceCategories).where(eq(serviceCategories.organizationId, org));
      const [r] = await tx.insert(serviceCategories).values({ organizationId: org, name: d.name, kind: d.kind, sort: max + 10 }).returning({ id: serviceCategories.id });
      return r;
    });
    await audit({ organizationId: org, userId: auth.user.id, action: "service_category.create", entity: "service_category", entityId: row.id, meta: { name: d.name, kind: d.kind } });
    return row;
  } catch (e) {
    if (uniqueViolation(e)) throw new ServiceCatalogError(`Die Kategorie „${d.name}“ gibt es schon.`);
    throw e;
  }
}

export async function renameServiceCategory(auth: AuthContext, id: string, name: unknown): Promise<void> {
  assertCan(auth, "settings.manage");
  const n = categoryInput.shape.name.parse(name);
  const org = auth.organization.id;
  try {
    const r = await withOrg(org, (tx) =>
      tx.update(serviceCategories).set({ name: n }).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, id))).returning({ id: serviceCategories.id }),
    );
    if (!r.length) throw new ServiceCatalogError("Kategorie nicht gefunden.");
  } catch (e) {
    if (uniqueViolation(e)) throw new ServiceCatalogError(`Die Kategorie „${n}“ gibt es schon.`);
    throw e;
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "service_category.rename", entity: "service_category", entityId: id, meta: { name: n } });
}

/** Eine Position nach oben (-1) oder unten (+1); Reihenfolge wird dabei lückenlos neu durchnummeriert */
export async function moveServiceCategory(auth: AuthContext, id: string, dir: -1 | 1): Promise<void> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  await withOrg(org, async (tx) => {
    const list = await tx.select({ id: serviceCategories.id }).from(serviceCategories).where(eq(serviceCategories.organizationId, org)).orderBy(asc(serviceCategories.sort), asc(serviceCategories.name)).for("update");
    const ids = list.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (const [k, cid] of ids.entries()) {
      await tx.update(serviceCategories).set({ sort: (k + 1) * 10 }).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, cid)));
    }
  });
}

/**
 * Alle Leistungen (auch archivierte) einer Kategorie in eine andere verschieben – Voraussetzung zum Löschen.
 * Die fachliche Art (services.category) folgt der Zielkategorie (DB-Trigger).
 */
export async function moveServicesToCategory(auth: AuthContext, fromId: string, toId: string): Promise<number> {
  assertCan(auth, "settings.manage");
  if (fromId === toId) return 0;
  const org = auth.organization.id;
  const n = await withOrg(org, async (tx) => {
    const cats = await tx.select({ id: serviceCategories.id }).from(serviceCategories).where(and(eq(serviceCategories.organizationId, org), inArray(serviceCategories.id, [fromId, toId])));
    if (cats.length !== 2) throw new ServiceCatalogError("Kategorie nicht gefunden.");
    const r = await tx.update(services).set({ categoryId: toId }).where(and(eq(services.organizationId, org), eq(services.categoryId, fromId))).returning({ id: services.id });
    return r.length;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "service_category.move_services", entity: "service_category", entityId: fromId, meta: { to: toId, count: n } });
  return n;
}

/** Löschen nur, wenn keine Leistung (auch keine archivierte) mehr darin ist */
export async function deleteServiceCategory(auth: AuthContext, id: string): Promise<void> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const name = await withOrg(org, async (tx) => {
    const [c] = await tx.select({ name: serviceCategories.name }).from(serviceCategories).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, id))).for("update");
    if (!c) throw new ServiceCatalogError("Kategorie nicht gefunden.");
    const [used] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(services).where(and(eq(services.organizationId, org), eq(services.categoryId, id)));
    if (used.n > 0) throw new ServiceCatalogError(`In „${c.name}“ sind noch ${used.n} Leistung(en) – bitte zuerst in eine andere Kategorie verschieben.`);
    await tx.delete(serviceCategories).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, id)));
    return c.name;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "service_category.delete", entity: "service_category", entityId: id, meta: { name } });
}

/** Ist das Kürzel (ohne Groß-/Kleinschreibung) schon bei einer Leistung (außer `exceptId`) oder einem Produkt vergeben? */
async function codeInUse(tx: Tx, org: string, code: string, exceptId?: string): Promise<boolean> {
  const needle = code.trim().toUpperCase();
  const [s] = await tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.organizationId, org), sql`upper(${services.code}) = ${needle}`, ...(exceptId ? [ne(services.id, exceptId)] : [])))
    .limit(1);
  if (s) return true;
  const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.organizationId, org), isNotNull(products.code), sql`upper(${products.code}) = ${needle}`)).limit(1);
  return !!p;
}

/**
 * Leistung archivieren bzw. wiederherstellen.
 * Archivieren gibt das Kürzel frei: „AN“ → „AN_archiv“ (bei Kollision „AN_archiv2“ …), damit „AN“ neu vergeben werden
 * kann. Rechnungspositionen speichern Bezeichnung/Preis/USt als Kopie (invoice_lines.description …) – alte Belege
 * ändern sich dadurch nicht. Wiederherstellen: Kürzel zurück, wenn frei; sonst bleibt das Archiv-Kürzel und
 * `codeConflict` nennt das belegte Kürzel.
 */
export async function setServiceActive(
  auth: AuthContext,
  id: string,
  active: boolean,
): Promise<{ code: string; codeConflict: string | null } | null> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    // Kürzel-Vergabe serialisieren (zwei gleichzeitige Archivierungen dürfen nicht dasselbe Archiv-Kürzel wählen)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('service-codes'), hashtext(${org}))`);
    const [s] = await tx.select({ code: services.code, active: services.active }).from(services).where(and(eq(services.organizationId, org), eq(services.id, id))).for("update");
    if (!s) return null;
    if (s.active === active) return { code: s.code, codeConflict: null };
    let code = s.code;
    let codeConflict: string | null = null;
    if (!active) {
      for (const candidate of archivedCodeCandidates(s.code)) {
        if (!(await codeInUse(tx, org, candidate, id))) {
          code = candidate;
          break;
        }
      }
    } else {
      const original = restoredCode(s.code);
      if (original !== s.code) {
        if (await codeInUse(tx, org, original, id)) codeConflict = original;
        else code = original;
      }
    }
    await tx.update(services).set({ active, code }).where(and(eq(services.organizationId, org), eq(services.id, id)));
    return { code, codeConflict, before: s.code };
  });
  if (res) {
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: active ? "service.unarchive" : "service.archive",
      entity: "service",
      entityId: id,
      meta: { code: res.code, ...("before" in res && res.before !== res.code ? { before: res.before } : {}), ...(res.codeConflict ? { codeConflict: res.codeConflict } : {}) },
    });
  }
  return res ? { code: res.code, codeConflict: res.codeConflict } : null;
}

/**
 * Wie oft wurde jede Leistung in den letzten 12 Monaten gebucht? (Termine + Rechnungspositionen, ohne abgesagte
 * Termine und stornierte/Entwurfs-Belege) – für die Reihenfolge „häufig gebucht“.
 */
export async function serviceUsageCounts(tx: Tx, org: string, now: Date = new Date()): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - 365 * 86_400_000);
  const appt = await tx
    .select({ id: appointmentServices.serviceId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(appointmentServices)
    .innerJoin(appointments, eq(appointments.id, appointmentServices.appointmentId))
    .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, since), sql`${appointments.status} not in ('cancelled')`))
    .groupBy(appointmentServices.serviceId);
  const lines = await tx
    .select({ id: invoiceLines.serviceId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.organizationId, org), isNotNull(invoiceLines.serviceId), gte(invoices.createdAt, since), sql`${invoices.status} not in ('cancelled', 'draft')`))
    .groupBy(invoiceLines.serviceId);
  const m = new Map<string, number>();
  for (const r of [...appt, ...lines]) if (r.id) m.set(r.id, (m.get(r.id) ?? 0) + r.n);
  return m;
}

/** Nach Häufigkeit sortieren (häufigste zuerst), Gleichstand alphabetisch nach Name */
export function sortByUsage<T extends { id: string; name: string }>(items: readonly T[], usage: Map<string, number>): T[] {
  return [...items].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || a.name.localeCompare(b.name, "de"));
}

/**
 * Aktive Leistungen der Praxis, „häufig gebucht“ zuerst – gemeinsame Quelle für Terminbuchung (Seite und Dialog) und
 * Rechnungs-Positionsauswahl. Läuft innerhalb einer bestehenden withOrg-Transaktion (tx) oder öffnet eine eigene.
 */
export async function servicesByUsage(org: string, tx?: Tx) {
  const run = async (t: Tx) => {
    const rows = await t.select().from(services).where(and(eq(services.organizationId, org), eq(services.active, true)));
    const usage = await serviceUsageCounts(t, org);
    return sortByUsage(rows, usage).map((s) => ({ ...s, usage: usage.get(s.id) ?? 0 }));
  };
  return tx ? run(tx) : withOrg(org, run);
}
