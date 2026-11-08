/**
 * Tarife für die öffentliche Preisseite. Bewusst eine lokale Konstante (unabhängig von der
 * Abo-Logik in src/lib/plans.ts) – bei Preisänderungen beide Stellen abgleichen.
 * Alle Preise netto (zzgl. USt.), vorläufig.
 */
export type PublicPlan = {
  id: "trial" | "starter" | "praxis" | "plus";
  name: string;
  price: string;
  period: string;
  therapists: string;
  note?: string;
  highlight?: boolean;
};

export const PUBLIC_PLANS: readonly PublicPlan[] = [
  { id: "trial", name: "Testphase", price: "0 €", period: "30 Tage", therapists: "alle Funktionen zum Ausprobieren", note: "endet automatisch, keine Zahlungsdaten nötig" },
  { id: "starter", name: "Starter", price: "59 €", period: "pro Monat", therapists: "1 Behandler:in" },
  { id: "praxis", name: "Praxis", price: "99 €", period: "pro Monat", therapists: "bis 5 Behandler:innen", highlight: true },
  { id: "plus", name: "Plus", price: "149 €", period: "pro Monat", therapists: "für größere Teams", note: "+15 € je weiterem Behandler:in" },
];

export const PRICE_NOTE = "Alle Preise zzgl. USt. Preise vorläufig.";
