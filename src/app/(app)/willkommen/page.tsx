import Link from "next/link";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { AddressAutocomplete, ZipInput } from "@/components/address-autocomplete";
import { Button, Card, Checkbox, Field, Input, LinkButton, Select } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { STATES } from "@/lib/holidays";
import { currentStep, ONBOARDING_STEPS, stepBySlug, type OnboardingProgress } from "@/lib/onboarding";
import { SERVICE_TEMPLATES } from "@/lib/service-templates";
import { isPrivateOnly, privateOnlyNote } from "@/lib/features";
import { inviteMemberAction } from "../einstellungen/actions";
import { applyServiceTemplateAction, completeStepAction, savePracticeStepAction } from "./actions";

export const metadata = { title: "Willkommen" };

function NextButton({ step, label = "Weiter" }: { step: string; label?: string }) {
  return (
    <form action={completeStepAction} className="mt-4">
      <input type="hidden" name="step" value={step} />
      <Button type="submit">{label}</Button>
    </form>
  );
}

export default async function WelcomePage({ searchParams }: PageProps<"/willkommen">) {
  const auth = await requireAuth("settings.manage");
  if (auth.role !== "owner" || auth.support) denyAccess(auth, "users.manage");
  const { schritt } = await searchParams;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  const progress = (org.onboarding ?? {}) as OnboardingProgress;
  const step = stepBySlug(schritt) ?? currentStep(progress);
  const privateOnly = isPrivateOnly(org);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-semibold">Willkommen bei PodoHero</h1>
      <p className="mt-1 text-muted">In wenigen Schritten ist {org.name} startklar. Du kannst jeden Schritt überspringen und später in den Einstellungen nachholen.</p>
      <ol aria-label="Schritte" className="my-6 flex flex-wrap gap-2">
        {ONBOARDING_STEPS.map((s, i) => (
          <li key={s.key}>
            <Link
              href={`/willkommen?schritt=${s.slug}`}
              aria-current={s.key === step.key ? "step" : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${s.key === step.key ? "bg-primary text-on-primary" : progress[s.key] ? "bg-primary-soft text-primary-soft-text" : "bg-surface-2 text-muted"}`}
            >
              <span aria-hidden>{progress[s.key] && s.key !== step.key ? "✓" : i + 1}</span> {s.label}
            </Link>
          </li>
        ))}
      </ol>

      <Card>
        {step.key === "practice" ? (
          <>
            <h2 className="mb-4 font-display text-xl font-semibold">Praxisdaten</h2>
            <p className="mb-4 text-sm text-muted">Erscheinen auf Rechnungen und Quittungen.</p>
            <ActionForm action={savePracticeStepAction} submit="Speichern und weiter">
              <Field label="Name der Praxis"><Input name="name" required defaultValue={org.name} /></Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Straße" className="sm:col-span-3"><AddressAutocomplete name="street" defaultValue={org.street ?? ""} /></Field>
                <Field label="PLZ"><ZipInput name="zip" defaultValue={org.zip ?? ""} /></Field>
                <Field label="Ort" className="sm:col-span-2"><Input name="city" defaultValue={org.city ?? ""} /></Field>
                <Field label="Telefon"><Input name="phone" defaultValue={org.phone ?? ""} /></Field>
                <Field label="E-Mail"><Input name="email" type="email" defaultValue={org.email ?? ""} /></Field>
                <Field label="Steuernummer"><Input name="taxNumber" defaultValue={org.taxNumber ?? ""} /></Field>
              </div>
              <Field label="Bundesland" hint="Für Feiertage im Kalender">
                <Select name="state" defaultValue={org.state}>
                  {Object.entries(STATES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </Select>
              </Field>
              <Checkbox name="smallBusiness" defaultChecked={org.smallBusiness} label="Kleinunternehmerregelung (§ 19 UStG)" />
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-semibold">Abrechnung</legend>
                <label className="flex min-h-11 items-center gap-3 text-[15px]">
                  <input type="radio" name="billingMode" value="private_only" defaultChecked={privateOnly} className="size-5 accent-[var(--primary)]" />
                  Privat &amp; Selbstzahler (ohne Kassenzulassung)
                </label>
                <label className="flex min-h-11 items-center gap-3 text-[15px]">
                  <input type="radio" name="billingMode" value="with_gkv" defaultChecked={!privateOnly} className="size-5 accent-[var(--primary)]" />
                  mit Kassenzulassung (GKV-Verordnungen)
                </label>
                <p className="text-sm text-muted">{privateOnlyNote()}</p>
              </fieldset>
            </ActionForm>
          </>
        ) : step.key === "services" ? (
          <>
            <h2 className="mb-4 font-display text-xl font-semibold">Leistungen</h2>
            <p className="mb-4 text-sm text-muted">Wähle eine Vorlage. Bereits vorhandene Leistungen und eigene Preise bleiben unverändert; alles lässt sich später unter Einstellungen → Leistungen anpassen.</p>
            <ActionForm action={applyServiceTemplateAction} submit="Vorlage übernehmen und weiter">
              {Object.entries(SERVICE_TEMPLATES).filter(([id]) => !privateOnly || id !== "gkv").map(([id, t]) => (
                <label key={id} className="flex cursor-pointer gap-3 rounded-xl border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input type="radio" name="template" value={id} defaultChecked={id === (privateOnly ? "selfpay" : "standard")} className="mt-1 size-5 accent-[var(--primary)]" />
                  <span><span className="block font-semibold">{t.label}</span><span className="text-sm text-muted">{t.description}</span></span>
                </label>
              ))}
            </ActionForm>
          </>
        ) : step.key === "team" ? (
          <>
            <h2 className="mb-4 font-display text-xl font-semibold">Team einladen</h2>
            <p className="mb-4 text-sm text-muted">Lege Kolleg:innen mit Rolle und Startpasswort an. Die Steuerberatung belegt keinen Platz. Weitere Personen jederzeit unter Einstellungen → Team.</p>
            <ActionForm action={inviteMemberAction} submit="Hinzufügen">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="E-Mail"><Input name="email" type="email" required /></Field>
                <Field label="Rolle">
                  <Select name="role" defaultValue="therapist">
                    <option value="therapist">Podolog:in</option>
                    <option value="reception">Empfang/Verwaltung</option>
                    <option value="trainee">Azubi/Praktikant:in</option>
                    <option value="accountant">Steuerberatung</option>
                    <option value="owner">Inhaber:in</option>
                  </Select>
                </Field>
                <Field label="Startpasswort" hint="min. 12 Zeichen"><Input name="password" type="text" minLength={12} autoComplete="off" /></Field>
              </div>
            </ActionForm>
            <NextButton step="team" />
          </>
        ) : step.key === "import" ? (
          <>
            <h2 className="mb-4 font-display text-xl font-semibold">Daten importieren</h2>
            <p className="text-sm text-muted">Kund:innen, Leistungen, Gutscheine und Rechnungen aus der Excel-Vorlage oder einer CSV-Datei übernehmen – mit Vorschau und Prüfbericht, bevor etwas gespeichert wird.</p>
            <LinkButton href="/einstellungen/import" variant="secondary" className="mt-4">Zum Import</LinkButton>
            <NextButton step="import" label="Erledigt / überspringen" />
          </>
        ) : step.key === "integrations" ? (
          <>
            <h2 className="mb-4 font-display text-xl font-semibold">Schnittstellen</h2>
            <p className="text-sm text-muted">lexoffice, SumUp, Doctolib, E-Mail, SMS und mehr. Alle Schnittstellen starten im Testmodus – es geht nichts nach außen, bis du sie verbindest.</p>
            <LinkButton href="/einstellungen/schnittstellen" variant="secondary" className="mt-4">Zu den Schnittstellen</LinkButton>
            <NextButton step="integrations" label="Erledigt / überspringen" />
          </>
        ) : (
          <>
            <h2 className="mb-2 font-display text-xl font-semibold">Fertig!</h2>
            <p className="text-sm text-muted">Deine Praxis ist eingerichtet. Tipp: Aktiviere unter Einstellungen → Sicherheit die Zwei-Faktor-Anmeldung.</p>
            <NextButton step="done" label="Zur Startseite" />
          </>
        )}
      </Card>
    </div>
  );
}
