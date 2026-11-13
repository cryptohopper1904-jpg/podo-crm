/**
 * Tarife für die öffentliche Preisseite und den Preis-Teaser der Startseite. Beträge kommen aus
 * src/lib/plans.ts (Netto-Cent) bzw. src/lib/website.ts – Brutto wird daraus berechnet, nichts hart codiert.
 * Nettopreise bleiben maßgeblich (B2B, AGB schließt Verbraucher aus); Brutto inkl. 19 % USt. nur zur Orientierung.
 * Preise vorläufig.
 */
import { moneyShort } from "@/lib/format";
import { EXTRA_SEAT_CENTS, extraSeatRange, FREE_MAX_PATIENTS, grossLabel, PLANS, seatSummary, type PaidPlan } from "@/lib/plans";
import { WEBSITE_ADDON_CENTS } from "@/lib/website";

export type PublicPlan = {
  id: "trial" | "free" | "starter" | "praxis" | "plus";
  name: string;
  /** Netto-Grundpreis pro Monat in Cent */
  priceCents: number;
  /** Hauptpreis, z. B. „59 €“ (netto) bzw. „0 €“ */
  price: string;
  /** Bruttopreis, z. B. „70,21 € inkl. USt.“ – null bei 0 € */
  gross: string | null;
  period: string;
  therapists: string;
  note?: string;
  highlight?: boolean;
};

const SEAT_FREE = "Empfang kostenlos";
const websiteAddon = `${moneyShort(WEBSITE_ADDON_CENTS)} netto/Monat (${grossLabel(WEBSITE_ADDON_CENTS)}, vorläufig)`;
const extraSeat = (id: PaidPlan) => {
  const range = extraSeatRange(id);
  return range ? `+${moneyShort(EXTRA_SEAT_CENTS)} netto (${grossLabel(EXTRA_SEAT_CENTS)}) je weiterer Behandler:in (${range})` : null;
};
const notes = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");

const plan = (p: Omit<PublicPlan, "price" | "gross">): PublicPlan => ({ ...p, price: moneyShort(p.priceCents), gross: grossLabel(p.priceCents) });

export const PUBLIC_PLANS: readonly PublicPlan[] = [
  plan({ id: "trial", name: "Testphase", priceCents: PLANS.trial.priceCents, period: "30 Tage", therapists: "alle Funktionen zum Ausprobieren", note: "endet automatisch, keine Zahlungsdaten nötig" }),
  plan({ id: "free", name: "Kostenlos", priceCents: PLANS.free.priceCents, period: "ohne Zeitlimit", therapists: `${seatSummary("free")}, bis ${FREE_MAX_PATIENTS} Patient:innen`, note: "Termine, Doku, Rechnungen, Kasse – ohne Portal, KI-Telefon, Website. Start über die Testphase, danach unter Abo & Tarif wählbar." }),
  plan({ id: "starter", name: "Starter", priceCents: PLANS.starter.priceCents, period: "pro Monat", therapists: seatSummary("starter"), note: notes(SEAT_FREE, `Praxis-Website als Zusatzmodul: ${websiteAddon}`) }),
  plan({ id: "praxis", name: "Praxis", priceCents: PLANS.praxis.priceCents, period: "pro Monat", therapists: seatSummary("praxis"), note: notes(extraSeat("praxis"), "inkl. Praxis-Website", SEAT_FREE), highlight: true }),
  plan({ id: "plus", name: "Plus", priceCents: PLANS.plus.priceCents, period: "pro Monat", therapists: seatSummary("plus"), note: notes(extraSeat("plus"), "inkl. Praxis-Website", SEAT_FREE) }),
];

/** Pflichthinweis (B2B, netto, vorläufig) – auf /preise und im Preis-Teaser der Startseite */
export const PRICE_NOTE = "Angebot ausschließlich für Unternehmer (§ 14 BGB), z. B. Praxen. Alle Preise netto zzgl. 19 % USt.; Bruttopreise zur Orientierung. Preise vorläufig (siehe unten).";

/** Erläuterung „vorläufig“ (unter den Tarifen auf /preise; Preisänderungen nach AGB § 4) */
export const PRICE_PRELIMINARY_TEXT =
  "Die Preise sind vorläufig: Bis zum offiziellen Start können wir Tarife und Preise für neue Verträge ändern. Für bereits gebuchte Tarife gilt der Preis bei Vertragsschluss; spätere Änderungen kündigen wir mindestens sechs Wochen vorher an, Sie können dann zum Wirksamwerden kündigen (AGB § 4).";

/** FAQ zu Plätzen – Zahlen aus src/lib/plans.ts */
export const SEATS_FAQ = `Nein, der Empfang ist kostenlos. Ein Platz ist für Personen mit Behandlungsrolle: Inhaber:in, Podolog:innen sowie Azubis/Praktikant:innen (sie arbeiten in der Behandlungsdoku). Diese sind je Tarif in fester Zahl enthalten (Starter ${PLANS.starter.includedSeats}, Praxis ${PLANS.praxis.includedSeats}, Plus ${PLANS.plus.includedSeats}); jede weitere kostet ${moneyShort(EXTRA_SEAT_CENTS)} netto im Monat (Praxis bis ${PLANS.praxis.maxSeats} Personen, Plus beliebig erweiterbar). Empfang/Verwaltung und Steuerberatung legen Sie kostenlos an. Ausnahme ist der kostenlose Tarif: Er ist auf eine Person begrenzt.`;

/** Zusatzmodule für die Preisseite (vorläufig) – Beträge aus src/lib/website.ts. */
export const ADDONS: readonly { id: string; name: string; description: string; pricing: string }[] = [
  {
    id: "website",
    name: "Praxis-Website",
    description: "Eigene moderne Praxis-Website aus Ihren Praxisdaten: Leistungen, Praxiszeiten, Hausbesuchsgebiet, Kontakt und „Termin online buchen“. Ohne Cookies und Tracking, hell/dunkel, für Smartphones optimiert. Eigene Domain möglich.",
    pricing: `In Praxis und Plus enthalten · Starter: +${websiteAddon}`,
  },
];
