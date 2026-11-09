import { asc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Field, Input, Select } from "@/components/ui";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { money } from "@/lib/format";
import { saveServiceAction } from "../actions";

export const metadata = { title: "Leistungen" };

function ServiceFields({ s }: { s?: typeof services.$inferSelect }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {s ? <input type="hidden" name="id" value={s.id} /> : null}
      <Field label="Kürzel"><Input name="code" defaultValue={s?.code} required maxLength={10} /></Field>
      <Field label="Bezeichnung" className="sm:col-span-2"><Input name="name" defaultValue={s?.name} required /></Field>
      <Field label="Preis (€)"><Input name="price" defaultValue={s ? (s.priceCents / 100).toFixed(2).replace(".", ",") : ""} required inputMode="decimal" /></Field>
      <Field label="USt">
        <Select name="vatRate" defaultValue={String(s?.vatRate ?? 0)}><option value="0">0 % (Heilbehandlung)</option><option value="7">7 %</option><option value="19">19 %</option></Select>
      </Field>
      <Field label="Dauer (Min)"><Input name="durationMin" type="number" defaultValue={s?.durationMin ?? 30} min={0} /></Field>
      <Field label="GKV-Pos."><Input name="gkvPosition" defaultValue={s?.gkvPosition ?? ""} /></Field>
      {s ? <Checkbox name="active" defaultChecked={s.active} label="aktiv" /> : null}
    </div>
  );
}

export default async function ServicesSettings() {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) => tx.select().from(services).where(eq(services.organizationId, org)).orderBy(asc(services.code)));
  // Hinweise aus dem Bootstrap (z. B. „Preis bitte prüfen“ bei Platzhalter-Preisen)
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const priceNotes = (o?.settings?.servicePriceNotes ?? {}) as Record<string, unknown>;
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        0 % USt nur für Heilbehandlungen mit therapeutischem Ziel (§ 4 Nr. 14 UStG). Kosmetische Fußpflege und Produktverkauf: 19 %. Im Zweifel mit der Steuerberatung klären.
      </p>
      <Card>
        <CardTitle>Neue Leistung</CardTitle>
        <ActionForm action={saveServiceAction} submit="Anlegen"><ServiceFields /></ActionForm>
      </Card>
      {rows.map((s) => (
        <Card key={s.id}>
          <p className="mb-3 flex items-center gap-2 font-semibold">{s.code} · {s.name} <Badge tone={s.vatRate ? "warn" : "primary"}>{s.vatRate} %</Badge> <span className="text-muted">{money(s.priceCents)}</span>{typeof priceNotes[s.code] === "string" ? <Badge tone="warn">{String(priceNotes[s.code])}</Badge> : null}</p>
          <ActionForm action={saveServiceAction}><ServiceFields s={s} /></ActionForm>
        </Card>
      ))}
    </div>
  );
}
