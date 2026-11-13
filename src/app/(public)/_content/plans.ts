/**
 * Tarife für die öffentliche Preisseite und den Preis-Teaser der Startseite. Beträge kommen aus
 * src/lib/plans.ts (Netto-Cent) bzw. src/lib/website.ts – Brutto wird daraus berechnet, nichts hart codiert.
 * Nettopreise bleiben maßgeblich (B2B, AGB schließt Verbraucher aus); Brutto inkl. 19 % USt. nur zur Orientierung.
 * Preise vorläufig.
 */
import { moneyShort } from "@/lib/format";
import { EXTRA_SEAT_CENTS, grossLabel, PLANS } from "@/lib/plans";
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

const SEAT_FREE = "Empfang und Azubis ohne eigenen Kalender sind kostenlos";
const websiteAddon = `${moneyShort(WEBSITE_ADDON_CENTS)} netto/Monat (${grossLabel(WEBSITE_ADDON_CENTS)}, vorläufig)`;

const plan = (p: Omit<PublicPlan, "price" | "gross">): PublicPlan => ({ ...p, price: moneyShort(p.priceCents), gross: grossLabel(p.priceCents) });

export const PUBLIC_PLANS: readonly PublicPlan[] = [
  plan({ id: "trial", name: "Testphase", priceCents: PLANS.trial.priceCents, period: "30 Tage", therapists: "alle Funktionen zum Ausprobieren", note: "endet automatisch, keine Zahlungsdaten nötig" }),
  plan({ id: "free", name: "Kostenlos", priceCents: PLANS.free.priceCents, period: "ohne Zeitlimit", therapists: "1 Person, bis 20 Patient:innen", note: "Termine, Doku, Rechnungen, Kasse – ohne Portal, KI-Telefon, Website. Start über die Testphase, danach unter Abo & Tarif wählbar." }),
  plan({ id: "starter", name: "Starter", priceCents: PLANS.starter.priceCents, period: "pro Monat", therapists: "1 Behandler:in", note: `${SEAT_FREE} · Praxis-Website als Zusatzmodul: ${websiteAddon}` }),
  plan({ id: "praxis", name: "Praxis", priceCents: PLANS.praxis.priceCents, period: "pro Monat", therapists: "bis 5 Behandler:innen", note: `inkl. Praxis-Website · ${SEAT_FREE}`, highlight: true }),
  plan({
    id: "plus",
    name: "Plus",
    priceCents: PLANS.plus.priceCents,
    period: "pro Monat",
    therapists: "für größere Teams",
    note: `inkl. Praxis-Website · +${moneyShort(EXTRA_SEAT_CENTS)} netto (${grossLabel(EXTRA_SEAT_CENTS)}) je weiterer Behandler:in · ${SEAT_FREE}`,
  }),
];

export const PRICE_NOTE = "Alle Preise netto zzgl. 19 % USt., Bruttopreise zur Orientierung. Preise vorläufig.";

/** Zusatzmodule für die Preisseite (vorläufig) – Beträge aus src/lib/website.ts. */
export const ADDONS: readonly { id: string; name: string; description: string; pricing: string }[] = [
  {
    id: "website",
    name: "Praxis-Website",
    description: "Eigene moderne Praxis-Website aus Ihren Praxisdaten: Leistungen, Praxiszeiten, Hausbesuchsgebiet, Kontakt und „Termin online buchen“. Ohne Cookies und Tracking, hell/dunkel, für Smartphones optimiert. Eigene Domain möglich.",
    pricing: `In Praxis und Plus enthalten · Starter: +${websiteAddon}`,
  },
];
