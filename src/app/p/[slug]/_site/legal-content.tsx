import type { PracticeLegal } from "@/server/website";

type Legal = Omit<PracticeLegal, "websitePublished" | "slug">;

/**
 * Impressum (§ 5 DDG): Stammdaten aus Einstellungen → Praxis inkl. strukturierter Pflichtangaben (src/lib/imprint.ts),
 * danach optional der Freitext der Praxis (Einstellungen → Website). Kein Platzhaltertext: Fehlen Pflichtangaben,
 * ist die Online-Buchung gesperrt und die Einstellungen warnen.
 */
export function ImprintContent({ site }: { site: Legal }) {
  const i = site.imprintInfo;
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-semibold">Impressum</h1>
      <h2 className="mt-6 font-semibold">Angaben gemäß § 5 DDG</h2>
      <p className="mt-2 leading-relaxed">
        {site.legalName ?? site.name}<br />
        {site.street ? <>{site.street}<br />{site.zip} {site.city}<br /></> : null}
      </p>
      {i.owner ? <p className="mt-2 leading-relaxed">Vertretungsberechtigte Person: {i.owner}</p> : null}
      <h2 className="mt-6 font-semibold">Kontakt</h2>
      <p className="mt-2 leading-relaxed">
        {site.phone ? <>Telefon: {site.phone}<br /></> : null}
        {site.email ? <>E-Mail: {site.email}</> : null}
      </p>
      {i.profession ? (
        <>
          <h2 className="mt-6 font-semibold">Berufsbezeichnung und berufsrechtliche Regelungen</h2>
          <p className="mt-2 leading-relaxed">
            Berufsbezeichnung: {i.profession} (verliehen in {i.professionState})<br />
            Berufsrechtliche Regelungen: {i.regulations}
          </p>
        </>
      ) : null}
      {i.authority ? (
        <>
          <h2 className="mt-6 font-semibold">Zuständige Aufsichtsbehörde</h2>
          <p className="mt-2 whitespace-pre-line leading-relaxed">{i.authority}</p>
        </>
      ) : null}
      {site.vatId || site.taxNumber ? (
        <>
          <h2 className="mt-6 font-semibold">Steuerangaben</h2>
          <p className="mt-2">{site.vatId ? `USt-IdNr.: ${site.vatId}` : `Steuernummer: ${site.taxNumber}`}</p>
        </>
      ) : null}
      {site.imprint ? <p className="mt-6 whitespace-pre-line leading-relaxed">{site.imprint}</p> : null}
    </article>
  );
}

/**
 * Pflichtinformationen zur Online-Terminanfrage (Art. 13 DSGVO), aus den Stammdaten erzeugt – stehen immer VOR dem
 * Freitext der Praxis. Speicherdauer „6 Monate“: src/server/online-request-retention.ts (täglicher Lauf).
 */
export function BookingPrivacyBlock({ site }: { site: Legal }) {
  const controller = [site.legalName ?? site.name, site.street, [site.zip, site.city].filter(Boolean).join(" "), site.email, site.phone].filter(Boolean).join(", ");
  return (
    <section className="mt-6 leading-relaxed">
      <h2 className="font-display text-xl font-semibold">Online-Terminanfrage</h2>
      <p className="mt-3">Verantwortlich für die Verarbeitung Ihrer Terminanfrage ist {controller}.</p>
      <p className="mt-3">
        <strong>Zweck und Rechtsgrundlage:</strong> Wir verarbeiten Ihren Namen, Ihre Mobilnummer, optional Ihre E-Mail-Adresse und Ihre Nachricht,
        um Ihre Terminanfrage zu bearbeiten und Sie zur Bestätigung zu kontaktieren (Art. 6 Abs. 1 lit. b DSGVO; soweit sich aus der Anfrage
        Gesundheitsbezüge ergeben, Art. 9 Abs. 2 lit. h DSGVO i. V. m. § 22 Abs. 1 Nr. 1 lit. b BDSG). Bitte geben Sie im Freitext keine Diagnosen an.
      </p>
      <p className="mt-3">
        <strong>Empfänger:</strong> Die Praxis nutzt die Praxissoftware PodoHero als Auftragsverarbeiter nach Art. 28 DSGVO; die Daten werden auf
        Servern in Deutschland gespeichert. Eine Übermittlung in Drittländer findet nicht statt.
      </p>
      <p className="mt-3">
        <strong>Speicherdauer:</strong> Kommt kein Termin zustande, wird die Anfrage spätestens nach 6 Monaten gelöscht; findet eine Behandlung statt,
        gelten die gesetzlichen Aufbewahrungsfristen (10 Jahre, § 630f Abs. 3 BGB).
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
      </section>
      <BookingPrivacyBlock site={site} />
      {site.privacy ? <div className="mt-6 whitespace-pre-line leading-relaxed">{site.privacy}</div> : null}
    </article>
  );
}
