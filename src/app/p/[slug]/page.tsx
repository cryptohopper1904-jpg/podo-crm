import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarCheck, Clock, Home, MapPin, Mail, Phone } from "lucide-react";
import { dateDe, money } from "@/lib/format";
import { mapLink, telHref, WEEKDAYS } from "@/lib/website";
import { loadPublicSite, type PublicSite } from "@/server/website";
import { SITE_ROBOTS, SiteShell } from "./_site/shell";

/**
 * Zusatzmodul „Praxis-Website“: öffentliche Mikroseite aus den Praxis-Einstellungen (Einstellungen → Website).
 * Öffentlich (src/proxy.ts PUBLIC "/p"), ohne Cookies/Tracking/Drittanbieter-Einbettungen, nur Geschäftsangaben.
 */
export const revalidate = 300;

const description = (s: PublicSite) =>
  (s.claim || `${s.name} – Podologie${s.city ? ` in ${s.city}` : ""}`) + (s.services.length ? `. Leistungen: ${s.services.slice(0, 4).map((x) => x.name).join(", ")}.` : "");

export async function generateMetadata(props: PageProps<"/p/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const site = await loadPublicSite(slug);
  if (!site) return { title: "Nicht gefunden", robots: { index: false, follow: false } };
  const title = site.city ? `${site.name} – Podologie in ${site.city}` : site.name;
  return {
    title: { absolute: title },
    description: description(site).slice(0, 300),
    robots: SITE_ROBOTS,
    alternates: { canonical: `/p/${site.slug}` },
    openGraph: { title, description: description(site).slice(0, 300), type: "website", locale: "de_DE", siteName: site.name },
  };
}

function hoursByDay(site: PublicSite) {
  const map = new Map<number, string[]>();
  for (const h of site.openingHours) map.set(h.weekday, [...(map.get(h.weekday) ?? []), `${h.from}–${h.to} Uhr`]);
  return [...map.entries()];
}

/** Strukturierte Daten für Suchmaschinen (schema.org), nur öffentliche Geschäftsangaben */
function jsonLd(site: PublicSite) {
  const dayCodes = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const data = {
    "@context": "https://schema.org",
    "@type": "MedicalBusiness",
    name: site.name,
    ...(site.claim ? { description: site.claim } : {}),
    ...(site.phone ? { telephone: site.phone } : {}),
    ...(site.email ? { email: site.email } : {}),
    ...(site.street ? { address: { "@type": "PostalAddress", streetAddress: site.street, postalCode: site.zip, addressLocality: site.city, addressCountry: "DE" } } : {}),
    ...(site.homeVisitAreas.length ? { areaServed: site.homeVisitAreas } : {}),
    ...(site.openingHours.length ? { openingHoursSpecification: site.openingHours.map((h) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: dayCodes[h.weekday], opens: h.from, closes: h.to })) } : {}),
  };
  // „<“ escapen, damit Texte aus den Einstellungen das Script-Element nicht beenden können
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function PracticeSitePage(props: PageProps<"/p/[slug]">) {
  const { slug } = await props.params;
  const site = await loadPublicSite(slug);
  if (!site) notFound();
  const tel = telHref(site.phone);
  const map = mapLink([site.street, [site.zip, site.city].filter(Boolean).join(" ")]);
  const days = hoursByDay(site);
  const upcoming = site.openingDate && site.openingDate > new Date().toISOString().slice(0, 10);
  return (
    <SiteShell site={site}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(site) }} />

      <section className="border-b border-border bg-primary-soft">
        <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
          {site.openingDate ? (
            <p className="mb-4 inline-flex rounded-full bg-surface px-3 py-1 text-sm font-semibold text-primary-soft-text">
              {upcoming ? `Eröffnung am ${dateDe(site.openingDate)}` : `Geöffnet seit ${dateDe(site.openingDate)}`}
            </p>
          ) : null}
          {site.privateOnly ? (
            <p className={`mb-4 inline-flex rounded-full bg-surface px-3 py-1 text-sm font-semibold text-primary-soft-text ${site.openingDate ? "ml-2" : ""}`}>Privatpatienten &amp; Selbstzahler</p>
          ) : null}
          <h1 className="font-display text-4xl font-bold tracking-tight text-primary-soft-text sm:text-5xl">{site.name}</h1>
          {site.claim ? <p className="mt-4 max-w-2xl text-lg text-primary-soft-text sm:text-xl">{site.claim}</p> : null}
          <div className="mt-8 flex flex-wrap gap-3">
            {site.onlineBooking ? (
              <a href={`/buchen/${site.slug}`} className="inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-5 text-base font-semibold text-on-accent hover:bg-accent-hover">
                <CalendarCheck size={20} aria-hidden /> Termin online buchen
              </a>
            ) : null}
            {tel ? (
              <a href={tel} className="inline-flex h-12 items-center gap-2 rounded-xl border border-border bg-surface px-5 text-base font-semibold hover:bg-surface-2">
                <Phone size={20} aria-hidden /> Anrufen
              </a>
            ) : null}
          </div>
        </div>
      </section>

      {site.about || site.practitioner ? (
        <section aria-labelledby="ueber" className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
          <h2 id="ueber" className="font-display text-2xl font-semibold">Über uns</h2>
          {site.practitioner ? (
            <p className="mt-3 font-semibold">
              {site.practitioner.name}
              {site.practitioner.qualification ? <span className="font-normal text-muted"> · {site.practitioner.qualification}</span> : null}
            </p>
          ) : null}
          {site.about ? <p className="mt-3 max-w-3xl whitespace-pre-line text-[17px] leading-relaxed">{site.about}</p> : null}
        </section>
      ) : null}

      {site.services.length ? (
        <section aria-labelledby="leistungen" className="border-y border-border bg-surface">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
            <h2 id="leistungen" className="font-display text-2xl font-semibold">Leistungen</h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {site.services.map((s) => (
                <li key={s.name} className="rounded-[var(--radius-card)] border border-border bg-bg p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-display text-lg font-semibold">{s.name}</h3>
                    {site.showPrices ? <span className="shrink-0 text-sm font-semibold tabular-nums">{s.priceCents !== null ? `ab ${money(s.priceCents)}` : "auf Anfrage"}</span> : null}
                  </div>
                  {s.description ? <p className="mt-2 text-[15px] text-muted">{s.description}</p> : null}
                  {s.durationMin > 0 ? <p className="mt-2 text-xs text-muted">ca. {s.durationMin} Minuten</p> : null}
                </li>
              ))}
            </ul>
            {site.showPrices ? (
              <p className="mt-4 text-xs text-muted">
                {site.privateOnly
                  ? "Preise für Privatpatienten und Selbstzahler. Sie erhalten eine Rechnung nach der Behandlung."
                  : "Preise für Selbstzahler. Behandlungen auf ärztliche Verordnung rechnen wir mit Ihrer Krankenkasse ab (ggf. zzgl. gesetzlicher Zuzahlung)."}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="mx-auto grid max-w-5xl gap-6 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div aria-labelledby="zeiten">
          <h2 id="zeiten" className="flex items-center gap-2 font-display text-xl font-semibold"><Clock size={20} aria-hidden className="text-primary" /> Praxiszeiten</h2>
          {days.length ? (
            <dl className="mt-3 flex flex-col gap-1.5 text-[15px]">
              {days.map(([d, slots]) => (
                <div key={d} className="flex justify-between gap-4">
                  <dt className="font-medium">{WEEKDAYS[d]}</dt>
                  <dd className="tabular-nums">{slots.join(", ")}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className={days.length ? "mt-2 text-xs text-muted" : "mt-3 text-[15px] text-muted"}>Termine nach Vereinbarung.</p>
        </div>
        <div aria-labelledby="hausbesuche">
          <h2 id="hausbesuche" className="flex items-center gap-2 font-display text-xl font-semibold"><Home size={20} aria-hidden className="text-primary" /> Hausbesuche</h2>
          {site.homeVisitAreas.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {site.homeVisitAreas.map((a) => <li key={a} className="rounded-full bg-surface-2 px-3 py-1 text-sm">{a}</li>)}
            </ul>
          ) : <p className="mt-3 text-[15px] text-muted">Bitte sprechen Sie uns an.</p>}
        </div>
        <div aria-labelledby="kontakt">
          <h2 id="kontakt" className="flex items-center gap-2 font-display text-xl font-semibold"><MapPin size={20} aria-hidden className="text-primary" /> Kontakt</h2>
          <address className="mt-3 flex flex-col gap-1.5 text-[15px] not-italic">
            {site.street ? <span>{site.street}<br />{site.zip} {site.city}</span> : null}
            {map ? <a href={map} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary">Route / Karte öffnen (OpenStreetMap)</a> : null}
            {tel ? <a href={tel} className="inline-flex items-center gap-2"><Phone size={16} aria-hidden /> {site.phone}</a> : null}
            {site.email ? <a href={`mailto:${site.email}`} className="inline-flex items-center gap-2 break-all"><Mail size={16} aria-hidden /> {site.email}</a> : null}
          </address>
        </div>
      </section>

      {site.onlineBooking ? (
        <section className="mx-auto max-w-5xl px-4 pb-14 sm:px-6">
          <div className="flex flex-col items-start gap-4 rounded-[var(--radius-card)] bg-accent-soft p-6 sm:flex-row sm:items-center">
            <p className="text-lg font-semibold text-accent-soft-text">Termin für Selbstzahler-Leistungen direkt online buchen.</p>
            <a href={`/buchen/${site.slug}`} className="inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-5 font-semibold text-on-accent hover:bg-accent-hover sm:ml-auto">
              <CalendarCheck size={20} aria-hidden /> Termin online buchen
            </a>
          </div>
        </section>
      ) : null}
    </SiteShell>
  );
}
