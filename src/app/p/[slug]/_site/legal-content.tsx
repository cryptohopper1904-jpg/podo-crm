import type { PracticeLegal } from "@/server/website";

type Legal = Omit<PracticeLegal, "websitePublished" | "slug">;

/** Impressum (§ 5 DDG): Stammdaten aus den Praxis-Einstellungen + Pflichtangaben, die die Praxis selbst ergänzt. */
export function ImprintContent({ site }: { site: Legal }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-semibold">Impressum</h1>
      <h2 className="mt-6 font-semibold">Angaben gemäß § 5 DDG</h2>
      <p className="mt-2 leading-relaxed">
        {site.legalName ?? site.name}<br />
        {site.street ? <>{site.street}<br />{site.zip} {site.city}<br /></> : null}
      </p>
      <h2 className="mt-6 font-semibold">Kontakt</h2>
      <p className="mt-2 leading-relaxed">
        {site.phone ? <>Telefon: {site.phone}<br /></> : null}
        {site.email ? <>E-Mail: {site.email}</> : null}
      </p>
      {site.vatId || site.taxNumber ? (
        <>
          <h2 className="mt-6 font-semibold">Steuerangaben</h2>
          <p className="mt-2">{site.vatId ? `USt-IdNr.: ${site.vatId}` : `Steuernummer: ${site.taxNumber}`}</p>
        </>
      ) : null}
      {site.imprint ? (
        <p className="mt-6 whitespace-pre-line leading-relaxed">{site.imprint}</p>
      ) : (
        <p className="mt-6 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
          Die Praxis ergänzt hier noch die weiteren Pflichtangaben (u. a. vertretungsberechtigte Person, Berufsbezeichnung und Staat der Verleihung,
          zuständige Aufsichtsbehörde, berufsrechtliche Regelungen).
        </p>
      )}
    </article>
  );
}

/** Datenschutzerklärung: Text der Praxis; ohne Text ein Hinweis auf die technische Gestaltung der Seite. */
export function PrivacyContent({ site }: { site: Legal }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-semibold">Datenschutz</h1>
      <section className="mt-6 rounded-xl bg-surface-2 p-4 text-[15px] leading-relaxed">
        <h2 className="font-semibold">Technische Hinweise zu dieser Website</h2>
        <p className="mt-2">
          Diese Website setzt keine Cookies, verwendet keine Analyse- oder Tracking-Werkzeuge und bindet keine Inhalte von Drittanbietern ein
          (Karten werden nur als Link geöffnet). Beim Aufruf verarbeitet der Server technisch notwendige Verbindungsdaten (z. B. IP-Adresse, Zeitpunkt),
          um die Seite auszuliefern und vor Missbrauch zu schützen. Eine gewählte Hell-/Dunkel-Darstellung wird nur lokal in Ihrem Browser gespeichert.
        </p>
      </section>
      {site.privacy ? (
        <div className="mt-6 whitespace-pre-line leading-relaxed">{site.privacy}</div>
      ) : (
        <p className="mt-6 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
          Die vollständige Datenschutzerklärung der Praxis (Verantwortliche Stelle, Zwecke, Rechtsgrundlagen, Ihre Rechte, Online-Buchung) wird hier noch ergänzt.
          Bei Fragen wenden Sie sich bitte direkt an die Praxis{site.email ? ` (${site.email})` : ""}.
        </p>
      )}
    </article>
  );
}
