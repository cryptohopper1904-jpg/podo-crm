import Link from "next/link";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { AddressAutocomplete, ZipInput } from "@/components/address-autocomplete";
import { Card, Checkbox, Field, Input, Select } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { STATES } from "@/lib/holidays";
import { imprintSettings } from "@/lib/imprint";
import { PRIVATE_ONLY_LABEL, isPrivateOnly, privateOnlyNote } from "@/lib/features";
import { readDunningSettings } from "@/lib/dunning";
import { formatIban } from "@/lib/invoice-view";
import { NO_HOURS_NOTE, openingSummary } from "@/lib/opening-hours";
import { parseOnlineBookingSettings } from "@/lib/portal-booking";
import { practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { LOGO_KINDS, LOGO_LABEL, logoInfo } from "@/server/practice-logos";
import { removeLogoAction, saveBankTaxAction, saveBillingModeAction, savePracticeAction } from "../actions";
import { DocumentsForm } from "./documents-form";
import { DunningForm } from "./dunning-form";
import { ImprintForm } from "./imprint-form";
import { ImprintWarning } from "./imprint-warning";
import { OnlineRequestRetentionNote } from "@/components/online-request-retention-note";
import { LogoUpload } from "./logo-upload";

const LOGO_HINT = {
  compact: "Nur das Zeichen (z. B. der Fuß). Erscheint dezent auf Anamnese- und Doku-Bögen sowie auf Quittungen.",
  full: "Das vollständige Logo mit Schriftzug. Erscheint im Rechnungskopf und in E-Mails an Patient:innen (z. B. Terminerinnerungen).",
} as const;

export const metadata = { title: "Praxis" };

export default async function PracticeSettings() {
  const auth = await requireAuth("settings.manage");
  const [o] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  const s = o.settings as { materialCostCents?: number };
  const logos = await logoInfo(o.id);
  const doc = readDocumentSettings(o.settings);
  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return (
    <div className="flex flex-col gap-6">
    <ImprintWarning org={o} settings={o.settings} />
    <Card>
      <h2 className="mb-2 font-display text-lg font-semibold">Abrechnung</h2>
      <ActionForm action={saveBillingModeAction}>
        <div>
          <Checkbox name="privateOnly" defaultChecked={isPrivateOnly(o)} label={PRIVATE_ONLY_LABEL} aria-describedby="private-only-note" />
          <p id="private-only-note" className="ml-8 text-sm text-muted">{privateOnlyNote()}</p>
        </div>
      </ActionForm>
    </Card>
    <Card>
      <h2 className="mb-2 font-display text-lg font-semibold">Online-Buchung</h2>
      <p className="text-sm text-muted">Eigene Buchungsseite für Selbstzahler-Leistungen (Alternative/Ergänzung zu Doctolib). Link auf der Website, bei Google und in WhatsApp teilen:</p>
      <a href={`/buchen/${o.slug}`} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all font-semibold text-primary">{(process.env.PUBLIC_URL ?? "")}/buchen/{o.slug}</a>
      <OnlineRequestRetentionNote className="mt-3" />
    </Card>
    <Card>
      <ActionForm action={savePracticeAction} stickyActions>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Praxisname"><Input name="name" defaultValue={o.name} required /></Field>
          <Field label="Rechtlicher Name (Rechnung)"><Input name="legalName" defaultValue={o.legalName ?? ""} /></Field>
          <Field label="Bundesland">
            <Select name="state" defaultValue={o.state}>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Straße"><AddressAutocomplete name="street" defaultValue={o.street ?? ""} /></Field>
          <Field label="PLZ"><ZipInput name="zip" defaultValue={o.zip ?? ""} /></Field>
          <Field label="Ort"><Input name="city" defaultValue={o.city ?? ""} /></Field>
          <Field label="Telefon"><Input name="phone" defaultValue={o.phone ?? ""} /></Field>
          <Field label="E-Mail"><Input name="email" type="email" defaultValue={o.email ?? ""} /></Field>
          <Field label="Materialkosten" hint="je Behandlung"><Input suffix="€" name="materialCost" defaultValue={((s.materialCostCents ?? 350) / 100).toFixed(2).replace(".", ",")} /></Field>
        </div>
        <p className="text-sm text-muted">
          Öffnungszeiten ({openingSummary(o.settings) ?? NO_HOURS_NOTE}) je Wochentag unter{" "}
          <Link className="font-semibold text-primary underline" href="/einstellungen/oeffnungszeiten">Einstellungen → Öffnungszeiten</Link>.
        </p>
        <Checkbox name="smallBusiness" defaultChecked={o.smallBusiness} label="Kleinunternehmer nach § 19 UStG (keine Umsatzsteuer auf Rechnungen)" />
      </ActionForm>
    </Card>
    <Card id="impressum" className="scroll-mt-24">
      <h2 className="mb-1 font-display text-lg font-semibold">Impressum (Pflichtangaben)</h2>
      <p className="mb-4 text-sm text-muted">
        Für das Impressum der Praxis-Website und der Online-Buchung (§ 5 DDG). Name, Anschrift, E-Mail und Telefon kommen aus den Praxisdaten oben.
        Ohne diese Angaben und die mit * markierten Felder ist die Online-Buchung gesperrt.
      </p>
      <ImprintForm initial={imprintSettings(o.settings)} />
    </Card>
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold">Logos</h2>
      <p className="mb-4 text-sm text-muted">Ohne Logo erscheinen Belege und E-Mails wie bisher mit dem Praxisnamen.</p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {LOGO_KINDS.map((kind) => {
          const l = logos[kind];
          return (
            // Subgrid: Beschreibung · Vorschau · Upload teilen sich die Zeilen beider Spalten → Upload-Felder auf einer Linie
            <div key={kind} className="flex flex-col gap-3 rounded-xl border border-border p-4 lg:row-span-3 lg:grid lg:grid-rows-subgrid">
              <p className="text-sm text-muted">{LOGO_HINT[kind]}</p>
              {l ? (
                <div className="flex items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- geschützte API-Route */}
                  <img src={`/api/praxis/logo/${kind}?v=${l.sha256.slice(0, 12)}`} alt={LOGO_LABEL[kind]} className="h-20 max-w-48 rounded-lg bg-white object-contain p-1" />
                  <div className="text-[13px] text-muted">
                    <p>{l.mime === "image/png" ? "PNG" : "JPEG"} · {l.width} × {l.height} px · {Math.ceil(l.sizeBytes / 1024)} KB</p>
                    <form action={removeLogoAction} className="mt-2">
                      <input type="hidden" name="kind" value={kind} />
                      <button type="submit" className="min-h-11 text-sm font-semibold text-danger">Logo entfernen</button>
                    </form>
                  </div>
                </div>
              ) : (
                <div className="hidden lg:block" />
              )}
              <LogoUpload kind={kind} label={l ? `${LOGO_LABEL[kind]} ersetzen` : LOGO_LABEL[kind]} />
            </div>
          );
        })}
      </div>
    </Card>
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold">Bankverbindung & Steuer (Rechnungen)</h2>
      <p className="mb-4 text-sm text-muted">Erscheint in der Fußzeile jeder Rechnung. Mit gültiger IBAN druckt PodoHero auf offene Rechnungen einen GiroCode zum Bezahlen per Banking-App.</p>
      <ActionForm action={saveBankTaxAction}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Kontoinhaber:in" hint="Leer = rechtlicher Name bzw. Praxisname"><Input name="accountHolder" defaultValue={o.accountHolder ?? ""} maxLength={70} /></Field>
          <Field label="IBAN"><Input name="iban" defaultValue={o.iban ? formatIban(o.iban) : ""} autoComplete="off" spellCheck={false} /></Field>
          <Field label="BIC (optional)"><Input name="bic" defaultValue={o.bic ?? ""} autoComplete="off" spellCheck={false} /></Field>
          <Field label="Bank"><Input name="bankName" defaultValue={o.bankName ?? ""} /></Field>
          <Field label="Steuernummer"><Input name="taxNumber" defaultValue={o.taxNumber ?? ""} /></Field>
          <Field label="USt-IdNr. (falls vorhanden)"><Input name="vatId" defaultValue={o.vatId ?? ""} /></Field>
        </div>
      </ActionForm>
    </Card>
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold">Belege: Fußzeile & Terminbuchung</h2>
      <p className="mb-4 text-sm text-muted">Angaben für Rechnungen und Quittungen.</p>
      <DocumentsForm
        doc={doc}
        websiteUrl={practiceWebsite(o.settings)}
        ownBookingUrl={publicUrl ? `${publicUrl}/buchen/${o.slug}` : null}
        ownBookingActive={parseOnlineBookingSettings(o.settings).enabled}
      />
    </Card>
    <Card id="mahnwesen">
      <h2 className="mb-1 font-display text-lg font-semibold">Mahnwesen</h2>
      <p className="mb-4 text-sm text-muted">
        Stufen für überfällige Privatrechnungen: Zahlungserinnerung, 1. Mahnung, 2. Mahnung (letzte Mahnung). Erstellen und Versand unter Rechnungen → Mahnungen.
      </p>
      <DunningForm settings={readDunningSettings(o.settings as Record<string, unknown>)} />
    </Card>
    </div>
  );
}
