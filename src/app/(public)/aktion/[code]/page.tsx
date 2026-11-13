import { Check } from "lucide-react";
import { connection } from "next/server";
import { LinkButton } from "@/components/ui";
import { requestMeta } from "@/lib/auth/session";
import { PLANS, TRIAL_DAYS } from "@/lib/plans";
import { normalizePromoCode, promoTermsText, trialDaysLabel } from "@/lib/promo-codes";
import { clientKey } from "@/lib/rate-limit";
import { lookupPromoCode, promoLookupLimiter } from "@/server/promo-codes";

/**
 * Öffentliche Aktionsseite für Vertriebskampagnen: /aktion/PODO-XXXX-XXXX.
 * Zeigt NUR für gültige Codes das Angebot (Testtage, ggf. Tarif-Umfang) – nie Bezeichnung, Kampagne, Einlösungen.
 * Ungültig/abgelaufen/aufgebraucht/unbekannt/gedrosselt → dieselbe neutrale Seite. Abrufe je Anschluss gedrosselt.
 * Nicht indexieren (Codes sind für einzelne Kampagnen gedacht).
 */
export const metadata = { title: "Aktion", robots: { index: false, follow: false } };

const POINTS = [
  "Termine, Patientenakte und Behandlungsdoku mit Fotos",
  "Rechnungen, Verordnungen und Hausbesuchs-Touren",
  "Keine Zahlungsdaten nötig – die Testphase endet automatisch",
  "Hosting in Deutschland, Daten jederzeit exportierbar",
];

export default async function PromoLandingPage({ params }: PageProps<"/aktion/[code]">) {
  await connection();
  const { code } = await params;
  let raw = code;
  try {
    raw = decodeURIComponent(code);
  } catch {
    // kaputte %-Folge → wie ungültiger Code
  }
  const normalized = normalizePromoCode(raw);
  const signupOpen = process.env.ALLOW_SIGNUP === "true";
  const offer = normalized && signupOpen && !promoLookupLimiter.limited(clientKey(await requestMeta())) ? await lookupPromoCode(normalized) : null;

  if (!offer) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
        <h1 className="font-display text-3xl font-bold tracking-tight">Diese Aktion ist nicht verfügbar</h1>
        <p className="mt-4 text-lg text-muted">Der Link ist ungültig oder abgelaufen. Sie können PodoHero trotzdem kostenlos testen.</p>
        <div className="mt-8">
          <LinkButton href="/einrichtung" variant="accent">Kostenlos testen</LinkButton>
        </div>
      </div>
    );
  }

  const span = trialDaysLabel(offer.trialDays);
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-primary">Aktion</p>
      <h1 className="mt-2 font-display text-4xl font-bold tracking-tight sm:text-5xl">PodoHero {span} kostenlos testen</h1>
      <p className="mt-4 text-lg text-muted">
        Mit dem Code <strong className="font-mono text-text">{offer.code}</strong> testen Sie die Praxissoftware für Podologie {span} lang
        {offer.grantPlan ? ` im Umfang des Tarifs „${PLANS[offer.grantPlan].label}“` : " mit allen Funktionen"}
        {offer.trialDays > TRIAL_DAYS && !offer.grantPlan ? ` – statt der üblichen ${TRIAL_DAYS} Tage` : ""}.
      </p>
      <ul className="mt-8 flex flex-col gap-3">
        {POINTS.map((p) => (
          <li key={p} className="flex items-start gap-3">
            <Check size={20} aria-hidden className="mt-0.5 shrink-0 text-primary" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <div className="mt-10 flex flex-wrap gap-3">
        <LinkButton href={`/einrichtung?code=${encodeURIComponent(offer.code)}`} variant="accent">Jetzt {span} kostenlos testen</LinkButton>
        <LinkButton href="/funktionen" variant="secondary">Funktionen ansehen</LinkButton>
        <LinkButton href="/preise" variant="ghost">Preise</LinkButton>
      </div>
      <section id="bedingungen" aria-labelledby="bedingungen-titel" className="mt-10 scroll-mt-24 rounded-[var(--radius-card)] border border-border bg-surface p-5 text-sm">
        <h2 id="bedingungen-titel" className="font-display text-lg font-semibold">Aktionsbedingungen</h2>
        <p className="mt-2 text-muted">{promoTermsText({ validUntil: offer.validUntil, limited: offer.limited }).replace(/^Aktionsbedingungen: /, "")}</p>
        <p className="mt-2 text-muted">
          <a href="/agb" className="font-semibold text-primary underline">AGB</a> · <a href="/preise" className="font-semibold text-primary underline">Preise</a>.
          Bereits registriert? Den Code können Inhaber:innen unter Einstellungen → Abo &amp; Tarif einlösen.
        </p>
      </section>
    </div>
  );
}
