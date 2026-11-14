import Link from "next/link";
import { eq } from "drizzle-orm";
import { Archive, ArchiveRestore, Clock, FolderCog, Pencil, Plus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, CardTitle, Empty, Field, Input, LinkButton, SegmentedControl, Select, Table } from "@/components/ui";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { filterCatalog, parseCatalogQuery, SORTS, type CatalogView } from "@/lib/catalog";
import { isArchivedCode, MAX_ARCHIVED_CODES, MAX_SERVICE_CODE_LENGTH, restoredCode } from "@/lib/service-codes";
import { archivedServicesBlockingCodes, listServiceCategories, serviceUsageCounts } from "@/server/service-catalog";
import { feature } from "@/lib/features";
import { money } from "@/lib/format";
import { currentCatalogView } from "@/server/catalog-prefs";
import { CatalogToolbar, catalogQs } from "../../_catalog/catalog-toolbar";
import { releaseArchivedCodesAction, saveServiceAction, setServiceActiveAction } from "../actions";

export const metadata = { title: "Leistungen" };

type Service = typeof services.$inferSelect;
type Category = { id: string; name: string; kind: string };
const BASE = "/einstellungen/leistungen";

/** gkv=false (Praxis nur Privat-/Selbstzahler): GKV-Position ausgeblendet, vorhandener Wert bleibt erhalten */
/**
 * Kategorien, die das Formular anbietet: Kategorien der Art „Verkauf (alt)“ (product) nur, wenn die Leistung schon
 * dort liegt – neue Verkaufsartikel gehören zu den Produkten.
 */
function selectableCategories(categories: Category[], s?: Service) {
  return categories.filter((c) => c.kind !== "product" || c.id === s?.categoryId);
}

/** Vorauswahl: bestehende Leistung → ihre Kategorie; neue Leistung → erste Kategorie der Art „Behandlung“ */
function defaultCategoryId(options: Category[], s?: Service) {
  return s?.categoryId ?? (options.find((c) => c.kind === "treatment") ?? options[0])?.id;
}

function ServiceFields({ s, gkv = true, categories }: { s?: Service; gkv?: boolean; categories: Category[] }) {
  // Archiviert: Kürzel ist das Archiv-Kürzel (z. B. „AN_archiv“) und kommt beim Wiederherstellen zurück – hier nicht änderbar
  const archivedCode = !!s && !s.active && isArchivedCode(s.code);
  const options = selectableCategories(categories, s);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {s ? <input type="hidden" name="id" value={s.id} /> : null}
      {archivedCode ? (
        <Field label="Kürzel" hint="archiviert – das ursprüngliche Kürzel kommt beim Wiederherstellen zurück, wenn es frei ist">
          <Input value={s.code} disabled readOnly />
        </Field>
      ) : (
        <Field label="Kürzel" hint="für die Schnelleingabe, z. B. PK"><Input name="code" defaultValue={s?.code} required maxLength={s && s.code.length > MAX_SERVICE_CODE_LENGTH ? s.code.length : MAX_SERVICE_CODE_LENGTH} className="uppercase" /></Field>
      )}
      <Field label="Bezeichnung" className="sm:col-span-2 lg:col-span-3"><Input name="name" defaultValue={s?.name} required /></Field>
      <Field label="Kategorie">
        <Select name="categoryId" defaultValue={defaultCategoryId(options, s)} required>
          {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Preis (€, brutto)"><Input name="price" defaultValue={s ? (s.priceCents / 100).toFixed(2).replace(".", ",") : ""} required inputMode="decimal" /></Field>
      <Field label="USt" hint="0 % = Heilbehandlung mit therapeutischem Ziel">
        <Select name="vatRate" defaultValue={String(s?.vatRate ?? 0)}><option value="0">0 % (Heilbehandlung)</option><option value="7">7 %</option><option value="19">19 %</option></Select>
      </Field>
      <Field label="Dauer (Min)"><Input name="durationMin" type="number" defaultValue={s?.durationMin ?? 30} min={0} max={480} /></Field>
      {gkv ? <Field label="GKV-Pos."><Input name="gkvPosition" defaultValue={s?.gkvPosition ?? ""} /></Field> : <input type="hidden" name="gkvPosition" value={s?.gkvPosition ?? ""} />}
    </div>
  );
}

function VatBadges({ s }: { s: Service }) {
  return (
    <>
      <Badge tone={s.vatRate ? "warn" : "primary"}>{s.vatRate} % USt</Badge>
      {s.requiresTherapeuticPurpose && s.vatRate === 0 ? <Badge tone="info">Heilbehandlung</Badge> : null}
      {!s.active ? <Badge>archiviert</Badge> : null}
    </>
  );
}

function RowActions({ s, qs, compact = false }: { s: Service; qs: string; compact?: boolean }) {
  const editHref = `${BASE}?${new URLSearchParams([...new URLSearchParams(qs), ["edit", s.id]])}`;
  return (
    <div className="flex items-center gap-1">
      <Link href={editHref} className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-primary hover:bg-surface-2" aria-label={`${s.name} bearbeiten`}>
        <Pencil size={15} aria-hidden /> {compact ? null : "Bearbeiten"}
      </Link>
      <form action={setServiceActiveAction}>
        <input type="hidden" name="id" value={s.id} />
        <input type="hidden" name="back" value={qs} />
        <input type="hidden" name="active" value={s.active ? "0" : "1"} />
        <button
          className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-muted hover:bg-surface-2"
          aria-label={s.active ? `${s.name} archivieren` : `${s.name} wiederherstellen`}
          title={s.active ? "Archivieren: verschwindet aus Termin- und Rechnungsauswahl, das Kürzel wird frei; alte Belege bleiben unverändert" : "Wiederherstellen"}
        >
          {s.active ? <Archive size={15} aria-hidden /> : <ArchiveRestore size={15} aria-hidden />} {compact ? null : s.active ? "Archivieren" : "Wiederherstellen"}
        </button>
      </form>
    </div>
  );
}

function ServiceList({ rows, view, qs, notes, categories }: { rows: Service[]; view: CatalogView; qs: string; notes: Record<string, unknown>; categories: Category[] }) {
  const catName = (s: Service) => categories.find((c) => c.id === s.categoryId)?.name ?? "–";
  const note = (s: Service) => (typeof notes[s.code] === "string" ? <Badge tone="warn">{String(notes[s.code])}</Badge> : null);
  if (view === "liste") {
    return (
      <Table label="Leistungen">
        <thead><tr><th>Kürzel</th><th>Bezeichnung</th><th>Kategorie</th><th className="text-right">Preis</th><th className="text-right">Dauer</th><th>USt</th><th></th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={s.active ? undefined : "opacity-60"}>
              <td className="font-mono font-semibold">{s.code}</td>
              <td>{s.name} {note(s)}</td>
              <td className="text-sm text-muted">{catName(s)}</td>
              <td className="text-right tabular-nums">{money(s.priceCents)}</td>
              <td className="text-right tabular-nums">{s.durationMin} Min</td>
              <td><div className="flex flex-wrap gap-1"><VatBadges s={s} /></div></td>
              <td><RowActions s={s} qs={qs} compact /></td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
  if (view === "kompakt") {
    return (
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {rows.map((s) => (
          <li key={s.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm ${s.active ? "" : "opacity-60"}`}>
            <span className="w-14 shrink-0 font-mono font-semibold">{s.code}</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="tabular-nums">{money(s.priceCents)}</span>
            <span className="w-16 text-right text-muted tabular-nums">{s.durationMin} Min</span>
            <span className="w-12 text-right text-muted">{s.vatRate} %</span>
            {!s.active ? <Badge>archiviert</Badge> : null}
            <RowActions s={s} qs={qs} compact />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {[...categories.map((c) => [c.name, rows.filter((s) => s.categoryId === c.id)] as const), ["Ohne Kategorie", rows.filter((s) => !categories.some((c) => c.id === s.categoryId))] as const]
        .filter(([, list]) => list.length > 0)
        .map(([cat, list]) => (
        <section key={cat}>
          <h2 className="mb-2 font-display text-lg font-semibold">{cat} <span className="text-sm font-normal text-muted">({list.length})</span></h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => (
              <article key={s.id} className={`flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-4 ${s.active ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 font-semibold leading-snug">{s.name}</h3>
                  <span className="shrink-0 rounded-lg bg-surface-2 px-2 py-0.5 font-mono text-sm font-semibold">{s.code}</span>
                </div>
                <p className="flex items-baseline gap-3">
                  <span className="font-display text-2xl font-bold tabular-nums">{money(s.priceCents)}</span>
                  <span className="inline-flex items-center gap-1 text-sm text-muted"><Clock size={14} aria-hidden /> {s.durationMin} Min</span>
                </p>
                <div className="flex flex-wrap gap-1"><VatBadges s={s} />{note(s)}</div>
                <div className="mt-auto -ml-2.5 pt-1"><RowActions s={s} qs={qs} /></div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function ServicesSettings(props: PageProps<"/einstellungen/leistungen">) {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const gkv = feature(auth.organization, "gkvServices");
  const sp = await props.searchParams;
  // Standard: „häufig gebucht“ (Termine + Rechnungspositionen der letzten 12 Monate), umschaltbar auf alphabetisch
  const query = parseCatalogQuery(sp, { sorts: SORTS, defaultSort: "haeufig" });
  const view = await currentCatalogView("services");
  const { all, categories, usage } = await withOrg(org, async (tx) => ({
    all: await tx.select().from(services).where(eq(services.organizationId, org)),
    categories: await listServiceCategories(tx, org),
    usage: await serviceUsageCounts(tx, org),
  }));
  // Hinweise aus dem Bootstrap (z. B. „Preis bitte prüfen“ bei Platzhalter-Preisen)
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const priceNotes = (o?.settings?.servicePriceNotes ?? {}) as Record<string, unknown>;
  // Kategorie-Filter über die Kategorie-ID (eigene Kategorien der Praxis)
  const rows = filterCatalog(all.map((s) => ({ ...s, category: s.categoryId ?? "" })), query, usage).map((r) => all.find((s) => s.id === r.id)!);
  const editing = typeof sp.edit === "string" ? all.find((s) => s.id === sp.edit) : undefined;
  const creating = sp.neu === "1";
  const qs = catalogQs(query, {}, "haeufig");
  const back = `${BASE}${qs ? `?${qs}` : ""}`;
  const usedCategories = categories.map((c) => [c.id, c.name] as const);
  // Hinweise nach dem Wiederherstellen: nur ein fester Schlüssel in der URL; das Kürzel kommt aus der DB und nur,
  // wenn die Leistung tatsächlich aktiv ist und noch ihr Archiv-Kürzel trägt
  const restoredHint = editing && editing.active && isArchivedCode(editing.code) ? restoredCode(editing.code) : null;
  const hint = sp.hinweis === "kuerzel-belegt" || sp.hinweis === "kuerzel-ungueltig" ? sp.hinweis : null;
  // Archiv-Ansicht: früher archivierte Leistungen, die ihr Kürzel noch blockieren (vor der Kürzel-Freigabe archiviert)
  const blocking = query.status !== "aktiv" ? await withOrg(org, (tx) => archivedServicesBlockingCodes(tx, org)) : [];
  const released = typeof sp.freigegeben === "string" && /^\d{1,4}$/.test(sp.freigegeben) ? Number(sp.freigegeben) : null;
  const skipped = typeof sp.uebersprungen === "string" && /^\d{1,4}$/.test(sp.uebersprungen) ? Number(sp.uebersprungen) : 0;
  const formCategories = selectableCategories(categories, editing);
  const sortHref = (sort: "haeufig" | "name") => {
    const p = new URLSearchParams(catalogQs({ ...query, sort }, {}, "haeufig"));
    return `${BASE}${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        0 % USt nur für Heilbehandlungen mit therapeutischem Ziel (§ 4 Nr. 14 UStG). Kosmetische Fußpflege: 19 %. Salben, Cremes &amp; Co. bitte unter{" "}
        <Link href="/produkte" className="font-semibold underline">Produkte</Link> anlegen. Nicht mehr benötigte Leistungen archivieren statt löschen – alte Termine und Rechnungen bleiben unverändert.
      </p>

      {sp.fehler === "archiv-kuerzel" && editing ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-danger">
          „{editing.name}“ wurde nicht archiviert: Für das Kürzel {editing.code} sind alle {MAX_ARCHIVED_CODES} Archiv-Kürzel belegt. Bitte unten zuerst ein anderes Kürzel eintragen, speichern und dann archivieren.
        </p>
      ) : null}

      {hint === "kuerzel-belegt" && editing && restoredHint !== null ? (
        <p role="status" className="rounded-xl bg-warn-soft p-4 text-sm font-medium text-warn-soft-text">
          „{editing.name}“ ist wiederhergestellt. Das Kürzel {restoredHint} ist inzwischen vergeben – die Leistung behält vorerst „{editing.code}“. Bitte unten ein neues Kürzel eintragen.
        </p>
      ) : null}

      {hint === "kuerzel-ungueltig" && editing && restoredHint !== null ? (
        <p role="status" className="rounded-xl bg-warn-soft p-4 text-sm font-medium text-warn-soft-text">
          „{editing.name}“ ist wiederhergestellt. Das ursprüngliche Kürzel {restoredHint ? `„${restoredHint}“` : "(leer)"} taugt nicht als Kürzel (1 bis {MAX_SERVICE_CODE_LENGTH} Zeichen) – die Leistung behält vorerst „{editing.code}“. Bitte unten ein neues Kürzel eintragen.
        </p>
      ) : null}

      {released !== null ? (
        <p role="status" className="rounded-xl bg-surface-2 p-4 text-sm font-medium">
          {released === 1 ? "1 Kürzel freigegeben." : `${released} Kürzel freigegeben.`}
          {skipped ? ` ${skipped} Leistung(en) übersprungen – alle Archiv-Kürzel belegt; bitte dort zuerst ein anderes Kürzel eintragen.` : ""}
        </p>
      ) : null}

      {blocking.length > 0 ? (
        <div role="note" className="flex flex-col gap-2 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="font-semibold">{blocking.length === 1 ? "1 archivierte Leistung blockiert" : `${blocking.length} archivierte Leistungen blockieren`} noch ihr Kürzel</span>{" "}
            ({blocking.slice(0, 8).map((b) => b.code).join(", ")}{blocking.length > 8 ? " …" : ""}) – sie wurden archiviert, bevor Archivieren das Kürzel freigab. Freigeben hängt „_archiv“ an, wie beim Archivieren; Wiederherstellen gibt es zurück.
          </p>
          <form action={releaseArchivedCodesAction} className="shrink-0">
            <input type="hidden" name="back" value={qs} />
            <Button type="submit" variant="secondary">Kürzel freigeben</Button>
          </form>
        </div>
      ) : null}

      {editing || creating ? (
        <Card>
          <CardTitle action={<Link href={back} className="text-sm font-semibold text-muted">Schließen</Link>}>
            {editing ? `Bearbeiten: ${editing.code} · ${editing.name}` : "Neue Leistung"}
          </CardTitle>
          {formCategories.length ? (
            <ActionForm key={editing?.id ?? "neu"} action={saveServiceAction} submit={editing ? "Änderung speichern" : "Anlegen"}>
              <ServiceFields s={editing} gkv={gkv} categories={categories} />
            </ActionForm>
          ) : (
            <p className="text-sm text-muted">
              Es gibt noch keine Kategorie für Leistungen. Bitte zuerst unter <Link href={`${BASE}/kategorien`} className="font-semibold underline">Kategorien verwalten</Link> eine anlegen.
            </p>
          )}
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`${BASE}?${new URLSearchParams([...new URLSearchParams(qs), ["neu", "1"]])}`}><Plus size={18} aria-hidden /> Neue Leistung</LinkButton>
          <LinkButton href={`${BASE}/kategorien`} variant="secondary"><FolderCog size={18} aria-hidden /> Kategorien verwalten</LinkButton>
        </div>
      )}

      <CatalogToolbar
        catalog="services"
        basePath={BASE}
        query={query}
        categories={usedCategories}
        view={view}
        counts={{ shown: rows.length, active: all.filter((s) => s.active).length, archived: all.filter((s) => !s.active).length }}
        sorts={SORTS}
        defaultSort="haeufig"
      >
        <SegmentedControl
          label="Reihenfolge"
          items={[
            { href: sortHref("haeufig"), label: "Häufig gebucht", active: query.sort === "haeufig", title: "Termine und Rechnungspositionen der letzten 12 Monate" },
            { href: sortHref("name"), label: "Alphabetisch", active: query.sort === "name" },
          ]}
        />
      </CatalogToolbar>

      {rows.length === 0 ? (
        <Empty title={all.length ? "Keine Leistung passt zum Filter" : "Noch keine Leistungen angelegt"}>
          {all.length ? <Link href={BASE} className="font-semibold text-primary">Filter zurücksetzen</Link> : null}
        </Empty>
      ) : (
        <ServiceList rows={rows} view={view} qs={qs} notes={priceNotes} categories={categories} />
      )}
    </div>
  );
}
