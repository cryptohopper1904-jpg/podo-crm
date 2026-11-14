import { SOLE_PROPRIETOR } from "@/lib/imprint";
import type { PracticeLegal } from "@/server/website";

type Legal = Omit<PracticeLegal, "websitePublished" | "slug">;

/** Aufbewahrung der Server-Protokolle (Container-Logs, deploy/log-retention.sh) – bei Änderung dort mitziehen */
export const SERVER_LOG_RETENTION_DAYS = 7;

/**
 * Impressum (§ 5 DDG): Stammdaten aus Einstellungen → Praxis inkl. strukturierter Pflichtangaben (src/lib/imprint.ts),
 * danach optional der Freitext der Praxis (Einstellungen → Website). Kein Platzhaltertext: Fehlen Pflichtangaben,
 * ist die Online-Buchung gesperrt und die App warnt. Keine Steuernummer (nicht vorgeschrieben, nur USt-IdNr./W-IdNr.).
 */
export function ImprintContent({ site }: { site: Legal }) {
  const i = site.imprintInfo;
  const sole = i.legalForm === SOLE_PROPRIETOR;
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-semibold">Impressum</h1>
      <h2 className="mt-6 font-semibold">Angaben gemäß § 5 DDG</h2>
      <p className="mt-2 leading-relaxed">
        {site.legalName ?? site.name}<br />
        {site.street ? <>{site.street}<br />{site.zip} {site.city}<br /></> : null}
      </p>
      {i.legalForm && !sole ? <p className="mt-2 leading-relaxed">Rechtsform: {i.legalForm}</p> : null}
      {i.owner ? <p className="mt-2 leading-relaxed">{sole ? "Inhaberin/Inhaber" : "Vertretungsberechtigte Person"}: {i.owner}</p> : null}
      <h2 className="mt-6 font-semibold">Kontakt</h2>
      <p className="mt-2 leading-relaxed">
        {site.phone ? <>Telefon: {site.phone}<br /></> : null}
        {site.email ? <>E-Mail: {site.email}</> : null}
      </p>
      {i.registerCourt || i.registerNumber ? (
        <>
          <h2 className="mt-6 font-semibold">Registereintrag</h2>
          <p className="mt-2 leading-relaxed">
            {i.registerCourt ? <>Registergericht: {i.registerCourt}<br /></> : null}
            {i.registerNumber ? <>Registernummer: {i.registerNumber}</> : null}
          </p>
        </>
      ) : null}
      {i.profession ? (
        <>
          <h2 className="mt-6 font-semibold">Berufsbezeichnung und berufsrechtliche Regelungen</h2>
          <p className="mt-2 leading-relaxed">
            Berufsbezeichnung: {i.profession} (verliehen in {i.professionState})
            {i.regulations ? <><br />Berufsrechtliche Regelungen: {i.regulations}</> : null}
          </p>
        </>
      ) : null}
      {i.authority ? (
        <>
          <h2 className="mt-6 font-semibold">Zuständige Aufsichtsbehörde</h2>
          <p className="mt-2 whitespace-pre-line leading-relaxed">{i.authority}</p>
        </>
      ) : null}
      {site.vatId || i.economicId ? (
        <>
          <h2 className="mt-6 font-semibold">Steuerangaben</h2>
          <p className="mt-2 leading-relaxed">
            {site.vatId ? <>Umsatzsteuer-Identifikationsnummer: {site.vatId}{i.economicId ? <br /> : null}</> : null}
            {i.economicId ? <>Wirtschafts-Identifikationsnummer: {i.economicId}</> : null}
          </p>
        </>
      ) : null}
      {i.dpo ? (
        <>
          <h2 className="mt-6 font-semibold">Datenschutzbeauftragte:r</h2>
          <p className="mt-2 whitespace-pre-line leading-relaxed">{i.dpo}</p>
        </>
      ) : null}
      {site.imprint ? <p className="mt-6 whitespace-pre-line leading-relaxed">{site.imprint}</p> : null}
    </article>
  );
}

/**
 * Pflichtinformationen zur Online-Terminanfrage (Art. 13 DSGVO), aus den Stammdaten erzeugt – stehen VOR dem
 * Freitext der Praxis, nur solange die Online-Buchung erreichbar ist. Empfänger: Drittland-Satz je nach Schalter
 * „KI-Antwortvorschläge“ (Anbieter und Land aus den Einstellungen; Garantie-Satz nur bei Drittland). Speicherdauer
 * „6 Monate nach Eingang“ nur, wenn der Löschlauf für die Praxis aktiv ist (AVV ab RETENTION_MIN_AVV akzeptiert,
 * src/server/online-request-retention.ts), sonst ohne festen Zeitraum; Datensicherungen: spätestens 30 Tage
 * (lokal 14 Tage, Zweitkopie 29 Tage – deploy/backup.sh, AVV § 10 Nr. 2).
 */
export function BookingPrivacyBlock({ site }: { site: Legal }) {
  const controller = [site.legalName ?? site.name, site.street, [site.zip, site.city].filter(Boolean).join(" "), site.email, site.phone].filter(Boolean).join(", ");
  const dpo = site.imprintInfo.dpo;
  // KI-Antwortvorschläge der Praxis (Einstellungen → Praxis): Anbieter/Land nur, wenn eingeschaltet (src/lib/ai-replies.ts)
  const ai = site.aiReplies;
  return (
    <section className="mt-6 leading-relaxed">
      <h2 className="font-display text-xl font-semibold">Online-Terminanfrage</h2>
      <p className="mt-3">Verantwortlich für die Verarbeitung Ihrer Terminanfrage ist {controller}.</p>
      {dpo ? <p className="mt-3 whitespace-pre-line"><strong>Datenschutzbeauftragte:r:</strong> {dpo}</p> : null}
      <p className="mt-3">
        <strong>Zweck und Rechtsgrundlage:</strong> Wir verarbeiten Ihren Namen, Ihre Mobilnummer, optional Ihre E-Mail-Adresse und Ihre Nachricht,
        um Ihre Terminanfrage zu bearbeiten und Sie zur Bestätigung zu kontaktieren (Art. 6 Abs. 1 lit. b DSGVO; soweit sich aus der Anfrage
        Gesundheitsbezüge ergeben, Art. 9 Abs. 2 lit. h DSGVO i. V. m. § 22 Abs. 1 Nr. 1 lit. b BDSG). Bitte geben Sie im Freitext keine Diagnosen an.
      </p>
      <p className="mt-3">
        <strong>Empfänger:</strong> Die Praxis nutzt die Praxissoftware PodoHero als Auftragsverarbeiter nach Art. 28 DSGVO; die Daten werden auf
        Servern in Deutschland gespeichert.{" "}
        {ai ? (
          <>
            Für Antwortvorschläge auf Ihre Nachricht nutzt die Praxis den KI-Dienst {ai.provider} ({ai.country}) als Auftragsverarbeiter. Dabei wird
            der Inhalt Ihrer Nachricht an {ai.provider} {ai.countryIn} übermittelt. Ihr Name, Ihre Telefonnummer und Ihre E-Mail-Adresse werden
            vorher automatisch entfernt. Namen oder andere persönliche Angaben, die Sie selbst in den Nachrichtentext schreiben, können dabei nicht in
            jedem Fall erkannt werden.
            {ai.thirdCountry ? (
              <>
                {" "}Die Übermittlung in dieses Land außerhalb der EU bzw. des EWR stützt sich auf einen Angemessenheitsbeschluss (Art. 45 DSGVO) oder
                Standardvertragsklauseln nach Art. 46 Abs. 2 lit. c DSGVO; eine Kopie der Garantien erhalten Sie bei der Praxis.
              </>
            ) : null}
          </>
        ) : (
          "Eine Übermittlung in Länder außerhalb der EU bzw. des EWR findet nicht statt."
        )}
      </p>
      <p className="mt-3">
        <strong>Speicherdauer:</strong>{" "}
        {site.onlineRequestRetention
          ? "Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, löschen wir 6 Monate nach Eingang automatisch."
          : "Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, löscht die Praxis, sobald sie für die Bearbeitung Ihrer Anfrage nicht mehr erforderlich sind."}{" "}
        Kopien in verschlüsselten Datensicherungen werden spätestens 30 Tage danach überschrieben. Kommt es zur
        Behandlung, gelten die gesetzlichen Aufbewahrungsfristen (10 Jahre nach § 630f Abs. 3 BGB).
      </p>
      <p className="mt-3">
        <strong>Ihre Rechte:</strong> Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch (Art. 15–21 DSGVO) sowie
        Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77 DSGVO).
      </p>
      <p className="mt-3">
        <strong>Bereitstellung:</strong> Name und Mobilnummer sind für die Terminanfrage erforderlich; ohne sie kann die Anfrage nicht bearbeitet werden.
      </p>
    </section>
  );
}

/** Datenschutz: technische Hinweise, Pflichtblock zur Online-Terminanfrage, danach optional der Text der Praxis. */
export function PrivacyContent({ site }: { site: Legal }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-semibold">Datenschutz</h1>
      <section className="mt-6 rounded-xl bg-surface-2 p-4 text-[15px] leading-relaxed">
        <h2 className="font-semibold">Technische Hinweise zu dieser Website</h2>
        <p className="mt-2">
          Diese Website setzt keine Cookies, verwendet keine Analyse- oder Tracking-Werkzeuge und bindet keine Inhalte von Drittanbietern ein
          (Karten werden nur als Link geöffnet). Beim Aufruf verarbeitet der Server durch PodoHero als Auftragsverarbeiter der Praxis technisch
          notwendige Verbindungsdaten (z. B. IP-Adresse, Zeitpunkt), um die Seite auszuliefern und vor Missbrauch zu schützen. Eine gewählte
          Hell-/Dunkel-Darstellung wird nur lokal in Ihrem Browser gespeichert.
        </p>
        <p className="mt-2">
          Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (sicherer Betrieb der Website); die Protokolldaten werden nach {SERVER_LOG_RETENTION_DAYS} Tagen gelöscht.
        </p>
      </section>
      {site.onlineBooking ? <BookingPrivacyBlock site={site} /> : null}
      {site.privacy ? <div className="mt-6 whitespace-pre-line leading-relaxed">{site.privacy}</div> : null}
    </article>
  );
}
