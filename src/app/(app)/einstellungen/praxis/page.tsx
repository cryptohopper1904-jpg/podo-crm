import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Card, Checkbox, Field, Input, Select } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { STATES } from "@/lib/holidays";
import { savePracticeAction } from "../actions";

export const metadata = { title: "Praxis" };

export default async function PracticeSettings() {
  const auth = await requireAuth("settings.manage");
  const [o] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  const s = o.settings as { materialCostCents?: number; opening?: { from: string; to: string } };
  return (
    <Card>
      <ActionForm action={savePracticeAction}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Praxisname"><Input name="name" defaultValue={o.name} required /></Field>
          <Field label="Rechtlicher Name (Rechnung)"><Input name="legalName" defaultValue={o.legalName ?? ""} /></Field>
          <Field label="Bundesland">
            <Select name="state" defaultValue={o.state}>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Straße"><Input name="street" defaultValue={o.street ?? ""} /></Field>
          <Field label="PLZ"><Input name="zip" defaultValue={o.zip ?? ""} /></Field>
          <Field label="Ort"><Input name="city" defaultValue={o.city ?? ""} /></Field>
          <Field label="Telefon"><Input name="phone" defaultValue={o.phone ?? ""} /></Field>
          <Field label="E-Mail"><Input name="email" type="email" defaultValue={o.email ?? ""} /></Field>
          <Field label="IBAN"><Input name="iban" defaultValue={o.iban ?? ""} /></Field>
          <Field label="Steuernummer"><Input name="taxNumber" defaultValue={o.taxNumber ?? ""} /></Field>
          <Field label="USt-IdNr."><Input name="vatId" defaultValue={o.vatId ?? ""} /></Field>
          <Field label="Materialkosten je Behandlung (€)"><Input name="materialCost" defaultValue={((s.materialCostCents ?? 350) / 100).toFixed(2).replace(".", ",")} /></Field>
          <Field label="Öffnung von"><Input type="time" name="openingFrom" defaultValue={s.opening?.from ?? "08:00"} /></Field>
          <Field label="Öffnung bis"><Input type="time" name="openingTo" defaultValue={s.opening?.to ?? "18:00"} /></Field>
        </div>
        <Checkbox name="smallBusiness" defaultChecked={o.smallBusiness} label="Kleinunternehmer nach § 19 UStG (keine Umsatzsteuer auf Rechnungen)" />
      </ActionForm>
    </Card>
  );
}
