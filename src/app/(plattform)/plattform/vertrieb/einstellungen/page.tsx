import { Card } from "@/components/ui";
import { dateDe } from "@/lib/format";
import { requirePlatformAdmin } from "@/server/platform";
import { getSalesSettings, listSuppressions, settingsProblems } from "@/server/vertrieb";
import { getLeadSearch } from "@/server/lead-search";
import { addSuppressionAction, saveLeadSearchAction, saveSettingsAction } from "../actions";
import { LeadSearchForm, SettingsForm, SuppressionForm } from "./forms";

export const metadata = { title: "Einstellungen · Vertrieb" };

export default async function SettingsPage() {
  await requirePlatformAdmin();
  const [s, supp, ls] = await Promise.all([getSalesSettings(), listSuppressions(), getLeadSearch()]);
  const problems = settingsProblems(s);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Card>
        <h2 className="mb-1 font-display text-xl font-semibold">Absender und Impressum</h2>
        <p className="mb-4 text-sm text-muted">
          Erscheint in jeder Mail. Die Absenderadresse muss eine beim Mail-Dienst (Resend) bestätigte Domain verwenden – Standard ist SMTP_FROM.
        </p>
        {problems.length ? <ul className="mb-4 list-disc rounded-xl bg-accent-soft py-3 pl-8 pr-4 text-sm text-accent-soft-text">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        <SettingsForm action={saveSettingsAction} values={{ senderName: s.senderName, senderEmail: s.senderEmail, replyTo: s.replyTo, impressum: s.impressum, ...s.delays, mailProcessorConfirmed: s.mailProcessorConfirmed }} />
      </Card>
      <Card>
        <h2 className="font-display text-xl font-semibold">Sperrliste</h2>
        <p className="mt-1 text-sm text-muted">
          An diese Adressen geht nie wieder eine Vertriebsmail – auch nach Löschen oder erneutem Import. Abmeldungen per Link landen automatisch hier;
          der Eintrag der Praxis wird dabei gelöscht. Gespeichert ist nur ein nicht umkehrbarer Prüfwert der Adresse, keine Adresse.
        </p>
        <div className="mt-4"><SuppressionForm action={addSuppressionAction} /></div>
        <p className="mt-4 text-sm"><strong className="tabular-nums">{supp.count}</strong> gesperrte Adressen</p>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {supp.recent.map((x, i) => (
            <li key={i} className="flex justify-between gap-2 border-t border-border pt-1">
              <span>{x.reason === "abgemeldet" ? "Abmeldelink" : x.reason === "widerspruch" ? "Widerspruch (manuell)" : "manuell"}</span>
              <span className="shrink-0 text-muted">{dateDe(x.createdAt)}</span>
            </li>
          ))}
          {supp.count === 0 ? <li className="text-muted">Noch keine Einträge.</li> : null}
        </ul>
      </Card>
      <Card className="lg:col-start-1">
        <h2 className="mb-1 font-display text-xl font-semibold">Praxissuche (nachts)</h2>
        <p className="mb-4 text-sm text-muted">
          Sucht jede Nacht im nächsten Ring um den Startort Podologie-/Fußpflegepraxen in OpenStreetMap und legt sie mit Status „Neu“ an.
          Übernommen werden Praxisname, Website, PLZ, Ort, Entfernung und eine allgemeine Praxis-Adresse (info@, praxis@, kontakt@ …) –
          keine Ansprechpartner, kein Telefon. Geschäftsadressen mit Namen (z. B. praxis.petra@) nur, wenn unten erlaubt, und nur
          von der eigenen Praxis-Website mit deren Domain; solche Einträge sind mit „Adresse mit Namensbezug“ markiert. Hinweis: Bei
          Einzelpraxen enthält schon der Praxisname oft den Namen der Inhaberin/des Inhabers. Fehlt die E-Mail in OpenStreetMap,
          werden höchstens Startseite und Impressum der Website gelesen (robots.txt wird beachtet). Es wird nie automatisch eine Mail versendet.
          {ls.center ? ` Stand: bis ${ls.doneKm} km von ${ls.maxKm} km durchsucht.` : ""}
        </p>
        <LeadSearchForm action={saveLeadSearchAction} values={{ enabled: ls.enabled, centerText: ls.center?.label ?? "", ringKm: ls.ringKm, maxKm: ls.maxKm, allowNamed: ls.allowNamed }} />
      </Card>
    </div>
  );
}
