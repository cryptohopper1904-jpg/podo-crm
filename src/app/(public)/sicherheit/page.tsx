import { Database, FileLock2, KeyRound, ListChecks, Lock, ScrollText, ServerCog, Sparkles, UserCog } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";

export const metadata = {
  title: "Sicherheit",
  description: "Wie PodoHero Gesundheitsdaten schützt: Hosting in Deutschland, Verschlüsselung, Row-Level-Security, Audit-Log, 2FA, kein KI-Training.",
};

const MEASURES = [
  {
    icon: ServerCog,
    title: "Hosting in Deutschland",
    text: "PodoHero läuft auf Servern in Deutschland (Docker, PostgreSQL, automatisches HTTPS). Keine US-Cloud für Praxisdaten. Datensicherungen werden verschlüsselt und rollierend 14 Tage aufbewahrt.",
  },
  {
    icon: Lock,
    title: "Verschlüsselung",
    text: "Übertragung immer per TLS mit HSTS. Fotos, Audio und Dokumente werden vor dem Speichern mit AES-256-GCM verschlüsselt – mit eigenem Schlüssel je Praxis. Zugangsdaten zu Schnittstellen und 2FA-Geheimnisse sind ebenfalls verschlüsselt.",
  },
  {
    icon: Database,
    title: "Doppelte Mandantentrennung",
    text: "Jede Abfrage ist in der Anwendung auf die eigene Praxis beschränkt. Zusätzlich erzwingt PostgreSQL Row-Level-Security; die Anwendung verbindet sich mit einer Rolle ohne Sonderrechte. Automatische Tests prüfen, dass Praxis B keine Daten von Praxis A sieht.",
  },
  {
    icon: FileLock2,
    title: "Unveränderbare Dokumentation",
    text: "Behandlungseinträge, Nachträge, Anamnesen, Einwilligungen und ausgestellte Rechnungen können in der Datenbank nicht geändert oder gelöscht werden (Trigger). Eine Hash-Kette je Patient macht Manipulationen erkennbar.",
  },
  {
    icon: ScrollText,
    title: "Zugriffsprotokoll",
    text: "Lesen und Schreiben von Akten und Fotos, Exporte, Anmeldungen und Einstellungsänderungen werden protokolliert. Das Protokoll ist ebenfalls unveränderbar und für Inhaber:innen einsehbar.",
  },
  {
    icon: KeyRound,
    title: "Anmeldung & Zwei-Faktor",
    text: "Passwörter mit Argon2id, Sperre nach wiederholten Fehlversuchen, Zwei-Faktor-Anmeldung mit jeder Authenticator-App, kurze Sitzungen mit sicherem Cookie.",
  },
  {
    icon: UserCog,
    title: "Rollen & Rechte",
    text: "Inhaber:in, Podolog:in, Empfang (ohne medizinische Inhalte), Azubi (mit Gegenzeichnung) und Steuerberatung (nur Finanzen). Der Betreiber hat keinen Dauerzugriff auf Praxisdaten.",
  },
  {
    icon: Sparkles,
    title: "Kein KI-Training",
    text: "Ihre Daten werden nicht zum Training von KI-Modellen verwendet. KI-Funktionen laufen im Testmodus, bis ein EU-Anbieter mit AVV und ohne Datenspeicherung bestätigt ist. Namen werden vor dem Versand entfernt.",
  },
] as const;

const INTEGRATIONS: { name: string; state: "real" | "test" | "planned"; note: string }[] = [
  { name: "lexoffice (Belege)", state: "real", note: "Anbindung implementiert; aktiv erst mit Ihrem API-Schlüssel, bis dahin Testmodus" },
  { name: "SumUp (Kartenterminal, Zahlungslink)", state: "real", note: "Anbindung implementiert; aktiv erst mit Ihrem SumUp-Zugang, bis dahin Testmodus" },
  { name: "Doctolib", state: "test", note: "CSV-Import und Auswertung von Bestätigungsmails; keine Live-Schnittstelle" },
  { name: "E-Mail-Versand", state: "test", note: "vorbereitet, Versand über einen Mailserver noch einzurichten" },
  { name: "SMS, WhatsApp", state: "test", note: "Testmodus; nur Organisatorisches, nur mit Einwilligung" },
  { name: "Google-Bewertungen", state: "test", note: "Testmodus bis zur API-Freigabe" },
  { name: "Sprachbericht (Transkription, KI)", state: "test", note: "technisch gesperrt bis zur Freigabe eines EU-Anbieters mit AVV" },
  { name: "Kassen-TSE (fiskaly)", state: "test", note: "Schnittstelle vorbereitet, Vertrag erforderlich" },
  { name: "KI-Telefon", state: "planned", note: "Pilot in Vorbereitung" },
];

const STATE_BADGE = {
  real: { tone: "primary", label: "echte Anbindung" },
  test: { tone: "info", label: "Testmodus" },
  planned: { tone: "neutral", label: "geplant" },
} as const;

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">Sicherheit & Datenschutz</h1>
        <p className="mt-4 text-lg text-muted">
          Podologie-Praxen arbeiten mit Gesundheitsdaten und unterliegen der Schweigepflicht. Hier beschreiben wir, was technisch umgesetzt ist –
          und ebenso offen, was noch aussteht.
        </p>
      </header>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        {MEASURES.map(({ icon: Icon, title, text }) => (
          <section key={title} className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text">
                <Icon size={20} aria-hidden />
              </span>
              <h2 className="text-lg font-semibold">{title}</h2>
            </div>
            <p className="mt-3 text-[15px] text-muted">{text}</p>
          </section>
        ))}
      </div>

      <section aria-labelledby="schnittstellen" className="mt-14">
        <h2 id="schnittstellen" className="font-display text-2xl font-semibold">Schnittstellen: echt oder Testmodus?</h2>
        <p className="mt-2 max-w-3xl text-muted">
          Im Testmodus werden keine Daten an den Anbieter übertragen; Ergebnisse sind klar als Test markiert. Für den Echtbetrieb schließt die Praxis
          einen eigenen Vertrag mit dem jeweiligen Anbieter.
        </p>
        <div className="mt-6 overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
            <thead>
              <tr className="bg-surface-2 text-sm">
                <th scope="col" className="px-4 py-3 font-semibold">Dienst</th>
                <th scope="col" className="px-4 py-3 font-semibold">Stand</th>
                <th scope="col" className="px-4 py-3 font-semibold">Hinweis</th>
              </tr>
            </thead>
            <tbody>
              {INTEGRATIONS.map((i) => (
                <tr key={i.name} className="border-t border-border">
                  <th scope="row" className="px-4 py-3 font-medium">{i.name}</th>
                  <td className="px-4 py-3"><Badge tone={STATE_BADGE[i.state].tone}>{STATE_BADGE[i.state].label}</Badge></td>
                  <td className="px-4 py-3 text-muted">{i.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="offen" className="mt-14 grid gap-6 lg:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 id="offen" className="flex items-center gap-2 font-display text-2xl font-semibold">
            <ListChecks size={22} aria-hidden className="text-primary" /> Noch offen
          </h2>
          <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 text-[15px]">
            <li>Externer Penetrationstest vor dem Start mit fremden Praxen</li>
            <li>Externe Signatur der Hash-Kette (manipulationssicherer Zeitstempel)</li>
            <li>Zweiter Standort für Datensicherungen, Schlüsselverwaltung in einem externen Tresor</li>
            <li>Anwaltliche Prüfung von AGB, AVV und Datenschutzerklärung</li>
          </ul>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 className="font-display text-2xl font-semibold">Ihre Daten bleiben Ihre Daten</h2>
          <p className="mt-3 text-[15px] text-muted">
            Inhaber:innen können jederzeit einen vollständigen Export erstellen: alle Tabellen als JSON und alle Fotos entschlüsselt, als ZIP-Datei.
            Nach einer Kündigung löschen wir die Praxis nach 30 Tagen Karenzzeit vollständig. Ihre gesetzlichen Aufbewahrungspflichten
            (z. B. 10 Jahre Behandlungsdokumentation) erfüllen Sie mit dem Export.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <LinkButton href="/avv" variant="secondary">Auftragsverarbeitung (AVV)</LinkButton>
            <LinkButton href="/unterauftragnehmer" variant="secondary">Unterauftragnehmer</LinkButton>
          </div>
        </div>
      </section>
    </div>
  );
}
