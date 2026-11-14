import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointmentServices, appointments, invoiceLines, invoices, organizations, products, serviceCategories, services } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/assert";
import { audit } from "@/lib/audit";
import type { ServiceKind } from "@/lib/catalog";
import { parseMoney } from "@/lib/format";
import { archivedCodeCandidates, isArchivedCode, isUsableCode, MAX_ARCHIVED_CODES, MAX_SERVICE_CODE_LENGTH, moveServiceCodeRefs, restoredCode } from "@/lib/service-codes";
import { codeTaken } from "@/server/products";

/**
 * Leistungs-Katalog der Praxis: eigene Kategorien (anlegen, umbenennen, sortieren, löschen), Archivieren mit
 * Kürzel-Freigabe und Reihenfolge nach Häufigkeit („häufig gebucht“).
 * Rechte: Pflege = settings.manage. Alle Abfragen über withOrg (RLS, eigener Mandant).
 */
export class ServiceCatalogError extends Error {}

export type ServiceCategory = typeof serviceCategories.$inferSelect;

/** Arten, die sich für neue Kategorien wählen lassen – „product“ nicht (Produkte haben eine eigene Tabelle; bestehende „Verkauf (alt)“-Kategorien bleiben) */
export const NEW_CATEGORY_KINDS = ["treatment", "brace", "cosmetic", "travel"] as const satisfies readonly ServiceKind[];

export const categoryInput = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen eingeben.").max(60, "Höchstens 60 Zeichen."),
  kind: z.enum(NEW_CATEGORY_KINDS, "Bitte eine gültige Art wählen.").default("treatment"),
});

/**
 * Kategorien der Praxis in Anzeige-Reihenfolge, mit Anzahl Leistungen (aktiv + archiviert). Nur lesend – die
 * Startkategorien entstehen in der Migration (Bestand) bzw. beim Anlegen der Praxis (src/lib/org-defaults.ts
 * seedServiceCategories); ein GET (auch im Nur-Lesen-Modus) schreibt nichts.
 */
export async function listServiceCategories(tx: Tx, org: string) {
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

const pgCode = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
const uniqueViolation = (e: unknown) => pgCode(e) === "23505";
const foreignKeyViolation = (e: unknown) => pgCode(e) === "23503";

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
  let before: string;
  try {
    before = await withOrg(org, async (tx) => {
      const [c] = await tx.select({ name: serviceCategories.name }).from(serviceCategories).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, id))).for("update");
      if (!c) throw new ServiceCatalogError("Kategorie nicht gefunden.");
      await tx.update(serviceCategories).set({ name: n }).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, id)));
      return c.name;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new ServiceCatalogError(`Die Kategorie „${n}“ gibt es schon.`);
    throw e;
  }
  if (before === n) return;
  await audit({ organizationId: org, userId: auth.user.id, action: "service_category.rename", entity: "service_category", entityId: id, meta: { name: n, before } });
}

/** Eine Position nach oben (-1) oder unten (+1); Reihenfolge wird dabei lückenlos neu durchnummeriert */
export async function moveServiceCategory(auth: AuthContext, id: string, dir: -1 | 1): Promise<void> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const moved = await withOrg(org, async (tx) => {
    const list = await tx.select({ id: serviceCategories.id }).from(serviceCategories).where(eq(serviceCategories.organizationId, org)).orderBy(asc(serviceCategories.sort), asc(serviceCategories.name)).for("update");
    const ids = list.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (const [k, cid] of ids.entries()) {
      await tx.update(serviceCategories).set({ sort: (k + 1) * 10 }).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, cid)));
    }
    return true;
  });
  if (moved) await audit({ organizationId: org, userId: auth.user.id, action: "service_category.move", entity: "service_category", entityId: id, meta: { dir: dir < 0 ? "up" : "down" } });
}

/**
 * Alle Leistungen (auch archivierte) einer Kategorie in eine andere verschieben – Voraussetzung zum Löschen.
 * Die fachliche Art (services.category) folgt der Zielkategorie (DB-Trigger).
 */
export async function moveServicesToCategory(auth: AuthContext, fromId: string, toId: string): Promise<number> {
  assertCan(auth, "settings.manage");
  if (fromId === toId) return 0;
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const cats = await tx
      .select({ id: serviceCategories.id, name: serviceCategories.name, kind: serviceCategories.kind })
      .from(serviceCategories)
      .where(and(eq(serviceCategories.organizationId, org), inArray(serviceCategories.id, [fromId, toId])));
    const from = cats.find((c) => c.id === fromId);
    const to = cats.find((c) => c.id === toId);
    if (!from || !to) throw new ServiceCatalogError("Kategorie nicht gefunden.");
    const r = await tx.update(services).set({ categoryId: toId }).where(and(eq(services.organizationId, org), eq(services.categoryId, fromId))).returning({ id: services.id });
    return { n: r.length, from, to };
  });
  // Art vorher/nachher: an ihr hängen Online-Buchung, Website und Wegegeld der verschobenen Leistungen
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "service_category.move_services",
    entity: "service_category",
    entityId: fromId,
    meta: { to: toId, count: res.n, fromName: res.from.name, toName: res.to.name, kindBefore: res.from.kind, kindAfter: res.to.kind },
  });
  return res.n;
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
  }).catch((e) => {
    // gleichzeitig eine Leistung in die Kategorie gelegt (FK services.category_id) → verständliche Meldung statt 500
    if (foreignKeyViolation(e)) throw new ServiceCatalogError("In der Kategorie ist inzwischen eine Leistung – bitte Seite neu laden und zuerst verschieben.");
    throw e;
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
 * Verweise per Kürzel in organizations.settings umschreiben (from → to) bzw. bei `to = null` entfernen
 * (Regeln: src/lib/service-codes.ts moveServiceCodeRefs). Innerhalb der Transaktion der Kürzel-Änderung, Zeile gesperrt.
 * Liefert die geänderten Einstellungs-Bereiche (leer = nichts geändert).
 */
export async function moveCodeRefsInSettings(tx: Tx, org: string, from: string, to: string | null): Promise<string[]> {
  if (from === to) return [];
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org)).for("update");
  const patch = moveServiceCodeRefs(o?.settings, from, to);
  if (!patch) return [];
  await tx
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(organizations.id, org));
  // geänderte Bereiche (onlineBooking, voice, website, servicePriceNotes) – fürs Audit-Log
  return Object.keys(patch).sort();
}

/**
 * Leistung archivieren bzw. wiederherstellen.
 * Archivieren gibt das Kürzel frei: „AN“ → „AN_archiv“ (bei Kollision „AN_archiv2“ …), damit „AN“ neu vergeben werden
 * kann. Rechnungspositionen speichern Bezeichnung/Preis/USt als Kopie (invoice_lines.description …) – alte Belege
 * ändern sich dadurch nicht. Wiederherstellen: Kürzel zurück, wenn frei; sonst bleibt das Archiv-Kürzel und
 * `codeConflict` nennt das belegte Kürzel. Taugt das zurückgewonnene Kürzel nicht (leer, zu lang – z. B. aus einem
 * Import), bleibt ebenfalls das Archiv-Kürzel und `codeInvalid` nennt es.
 */
export async function setServiceActive(
  auth: AuthContext,
  id: string,
  active: boolean,
): Promise<{ code: string; codeConflict: string | null; codeInvalid?: string } | null> {
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
    let codeInvalid: string | undefined;
    if (!active) {
      let free: string | null = null;
      for (const candidate of archivedCodeCandidates(s.code)) {
        if (!(await codeInUse(tx, org, candidate, id))) {
          free = candidate;
          break;
        }
      }
      if (!free) {
        throw new ServiceCatalogError(
          `Für „${s.code}“ sind alle ${MAX_ARCHIVED_CODES} Archiv-Kürzel belegt. Bitte der Leistung zuerst ein anderes Kürzel geben und dann archivieren.`,
        );
      }
      code = free;
    } else {
      const original = restoredCode(s.code);
      if (original !== s.code) {
        if (!isUsableCode(original)) codeInvalid = original;
        else if (await codeInUse(tx, org, original, id)) codeConflict = original;
        else code = original;
      }
    }
    await tx.update(services).set({ active, code }).where(and(eq(services.organizationId, org), eq(services.id, id)));
    // Verweise per Kürzel (Online-/Telefonbuchung, Website-Beschreibung, Preis-Hinweis) wandern mit – ein freigegebenes
    // Kürzel vererbt so nichts an eine neue Leistung
    const refsMoved = await moveCodeRefsInSettings(tx, org, s.code, code);
    return { code, codeConflict, codeInvalid, before: s.code, refsMoved };
  });
  if (res && "before" in res) {
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: active ? "service.unarchive" : "service.archive",
      entity: "service",
      entityId: id,
      meta: {
        code: res.code,
        ...(res.before !== res.code ? { before: res.before } : {}),
        ...(res.codeConflict ? { codeConflict: res.codeConflict } : {}),
        ...(res.codeInvalid !== undefined ? { codeInvalid: res.codeInvalid } : {}),
        ...(res.refsMoved?.length ? { refsMoved: res.refsMoved } : {}),
      },
    });
  }
  return res ? { code: res.code, codeConflict: res.codeConflict, ...(res.codeInvalid !== undefined ? { codeInvalid: res.codeInvalid } : {}) } : null;
}

/**
 * Wie oft wurde jede Leistung in den letzten 12 Monaten gebucht? (Termine + Rechnungspositionen, ohne abgesagte
 * und nicht wahrgenommene Termine, ohne stornierte/Entwurfs-Belege und ohne Gutschriften – eine Gutschrift nimmt
 * eine Leistung zurück, ist also keine Buchung) – für die Reihenfolge „häufig gebucht“.
 */
export async function serviceUsageCounts(tx: Tx, org: string, now: Date = new Date()): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - 365 * 86_400_000);
  // Rechnungen nach Ausstellungsdatum (Index invoices_org_issued); Entwürfe haben keins
  const sinceDay = since.toISOString().slice(0, 10);
  const appt = await tx
    .select({ id: appointmentServices.serviceId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(appointmentServices)
    .innerJoin(appointments, eq(appointments.id, appointmentServices.appointmentId))
    .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, since), sql`${appointments.status} not in ('cancelled', 'no_show')`))
    .groupBy(appointmentServices.serviceId);
  const lines = await tx
    .select({ id: invoiceLines.serviceId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.organizationId, org), eq(invoices.organizationId, org), isNotNull(invoiceLines.serviceId), gte(invoices.issuedAt, sinceDay), sql`${invoices.status} not in ('cancelled', 'draft')`, ne(invoices.kind, "credit_note")))
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

const optText = z.string().trim().max(300).optional().transform((v) => v || null);

/** Formular „Leistung“ (Einstellungen → Leistungen); leere Felder sind vorher entfernt */
export const serviceInput = z.object({
  id: z.uuid().optional(),
  // Länge erst in saveService prüfen: ein unverändertes Alt-/Archiv-Kürzel darf länger sein (z. B. „BEHAND_archiv“)
  code: z.string().trim().min(1, "Bitte ein Kürzel eingeben.").max(40, "Kürzel zu lang.").toUpperCase().optional(),
  name: z.string().trim().min(2, "Bezeichnung: mindestens 2 Zeichen.").max(200),
  price: z.string(),
  vatRate: z.coerce.number().refine((v) => [0, 7, 19].includes(v), "Bitte einen gültigen USt-Satz wählen."),
  durationMin: z.coerce.number().int().min(0).max(480),
  categoryId: z.uuid("Bitte eine Kategorie wählen."),
  gkvPosition: optText,
});

export type SaveServiceResult = { error: string } | { ok: true; id: string; code: string };

/**
 * Leistung anlegen oder ändern. Aktiv/archiviert ändert nur setServiceActive; neue Leistungen sind aktiv.
 *  - Kürzel mit Archiv-Zusatz („…_archiv“, „…_ARCHIV2“) sind für archivierte Leistungen reserviert und werden als
 *    neue Eingabe abgelehnt; ein unverändertes Kürzel (z. B. nach Wiederherstellen mit belegtem Kürzel) bleibt erlaubt.
 *  - Archivierte Leistung mit Archiv-Kürzel: Kürzel bleibt (kommt beim Wiederherstellen zurück).
 *  - Kürzel geändert: Verweise in den Einstellungen wandern mit; neue Leistung erbt keine Altverweise.
 * Audit „service.save“ mit entityId, bei Änderung des Kürzels auch dem alten (`before`) und den mitgewanderten Verweisen.
 */
export async function saveService(auth: AuthContext, input: unknown): Promise<SaveServiceResult> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const parsed = serviceInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const priceCents = parseMoney(d.price);
  if (priceCents === null) return { error: "Preis ungültig" };
  const base = {
    name: d.name,
    priceCents,
    vatRate: d.vatRate,
    durationMin: d.durationMin,
    // Art (services.category) setzt der DB-Trigger aus der Kategorie
    categoryId: d.categoryId,
    gkvPosition: d.gkvPosition,
    requiresTherapeuticPurpose: d.vatRate === 0,
  };
  let code = d.code ?? "";
  type Done = { id: string; created: boolean; before: string | null; refsMoved: string[] };
  let res: Done | { error: string };
  try {
    res = await withOrg(org, async (tx): Promise<Done | { error: string }> => {
      // Kürzel-Vergabe und Verweise per Kürzel serialisieren (wie Archivieren)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('service-codes'), hashtext(${org}))`);
      const [cat] = await tx.select({ id: serviceCategories.id }).from(serviceCategories).where(and(eq(serviceCategories.organizationId, org), eq(serviceCategories.id, d.categoryId)));
      if (!cat) return { error: "Kategorie nicht gefunden." };
      const [current] = d.id
        ? await tx.select({ code: services.code, active: services.active }).from(services).where(and(eq(services.organizationId, org), eq(services.id, d.id))).for("update")
        : [];
      if (d.id && !current) return { error: "Leistung nicht gefunden." };
      if (current && !current.active && isArchivedCode(current.code)) code = current.code;
      else if (current && code.toUpperCase() === current.code.toUpperCase()) code = current.code;
      else if (code && isArchivedCode(code)) {
        return { error: `Kürzel mit „_archiv“ am Ende sind für archivierte Leistungen reserviert – bitte ein anderes Kürzel wählen.` };
      }
      if (!code) return { error: "Bitte ein Kürzel eingeben." };
      const unchanged = !!current && code === current.code;
      if (!unchanged && code.length > MAX_SERVICE_CODE_LENGTH) return { error: `Kürzel höchstens ${MAX_SERVICE_CODE_LENGTH} Zeichen.` };
      // Kürzel-Schnelleingabe in der Rechnung: Leistungen und Produkte teilen sich die Kürzel
      if (await codeTaken(tx, org, code, "product")) return { error: `Das Kürzel ${code} hat schon ein Produkt. Bitte ein anderes wählen.` };
      if (d.id && current) {
        await tx.update(services).set({ ...base, code }).where(and(eq(services.organizationId, org), eq(services.id, d.id)));
        // Kürzel geändert: Verweise (Online-/Telefonbuchung, Website-Beschreibung, Preis-Hinweis) wandern mit
        const refsMoved = current.code !== code ? await moveCodeRefsInSettings(tx, org, current.code, code) : [];
        return { id: d.id, created: false, before: current.code !== code ? current.code : null, refsMoved };
      }
      const [row] = await tx.insert(services).values({ ...base, code, active: true, organizationId: org }).returning({ id: services.id });
      // neue Leistung mit (evtl. freigewordenem) Kürzel erbt keine Altverweise
      const refsMoved = await moveCodeRefsInSettings(tx, org, code, null);
      return { id: row.id, created: true, before: null, refsMoved };
    });
  } catch (e) {
    if (uniqueViolation(e)) return { error: `Das Kürzel ${code} gibt es schon.` };
    if (pgCode(e) === "23514" || foreignKeyViolation(e)) return { error: "Kategorie passt nicht – bitte Seite neu laden und erneut wählen." };
    throw e;
  }
  if ("error" in res) return res;
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "service.save",
    entity: "service",
    entityId: res.id,
    meta: {
      code,
      ...(res.created ? { created: true } : {}),
      ...(res.before ? { before: res.before } : {}),
      ...(res.refsMoved.length ? { refsMoved: res.refsMoved } : {}),
    },
  });
  return { ok: true, id: res.id, code };
}

/**
 * Früher (vor der Kürzel-Freigabe) archivierte Leistungen behalten ihr altes Kürzel und blockieren es. Liste für den
 * Hinweis im Archiv.
 */
export async function archivedServicesBlockingCodes(tx: Tx, org: string) {
  const rows = await tx
    .select({ id: services.id, code: services.code, name: services.name })
    .from(services)
    .where(and(eq(services.organizationId, org), eq(services.active, false)))
    .orderBy(asc(services.code));
  return rows.filter((r) => !isArchivedCode(r.code));
}

/**
 * Kürzel aller früher archivierten Leistungen freigeben (wie beim Archivieren: „AN“ → „AN_archiv“ …, Verweise
 * wandern mit). Leistungen, für die kein Archiv-Kürzel mehr frei ist, bleiben unverändert. Liefert die Anzahl
 * freigegebener und übersprungener Kürzel.
 */
export async function releaseArchivedCodes(auth: AuthContext): Promise<{ released: number; skipped: number }> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const changes = await withOrg(org, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('service-codes'), hashtext(${org}))`);
    const rows = await tx
      .select({ id: services.id, code: services.code })
      .from(services)
      .where(and(eq(services.organizationId, org), eq(services.active, false)))
      .orderBy(asc(services.code))
      .for("update");
    const out: { id: string; before: string; code: string | null; refsMoved: string[] }[] = [];
    for (const r of rows) {
      if (isArchivedCode(r.code)) continue;
      let free: string | null = null;
      for (const candidate of archivedCodeCandidates(r.code)) {
        if (!(await codeInUse(tx, org, candidate, r.id))) {
          free = candidate;
          break;
        }
      }
      if (!free) {
        out.push({ id: r.id, before: r.code, code: null, refsMoved: [] });
        continue;
      }
      await tx.update(services).set({ code: free }).where(and(eq(services.organizationId, org), eq(services.id, r.id)));
      out.push({ id: r.id, before: r.code, code: free, refsMoved: await moveCodeRefsInSettings(tx, org, r.code, free) });
    }
    return out;
  });
  for (const c of changes) {
    if (!c.code) continue;
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "service.release_code",
      entity: "service",
      entityId: c.id,
      meta: { code: c.code, before: c.before, ...(c.refsMoved.length ? { refsMoved: c.refsMoved } : {}) },
    });
  }
  return { released: changes.filter((c) => c.code).length, skipped: changes.filter((c) => !c.code).length };
}
