/**
 * Geplanter Connector für Doctolib (Seite /connector-fuer-doctolib). Noch NICHT verfügbar: Der Start setzt einen von
 * Doctolib freigegebenen Schnittstellenzugang voraus. Preise sind geplante Netto-Beträge in Cent, vorläufig.
 */
import { moneyShort } from "@/lib/format";
import { grossLabel } from "@/lib/plans";

/** Einzelprodukt: je Praxis und Monat, inkl. CONNECTOR_INCLUDED_CALENDARS Kalender */
export const CONNECTOR_STANDALONE_CENTS = 1900;
/** Jeder weitere Kalender im Einzelprodukt */
export const CONNECTOR_EXTRA_CALENDAR_CENTS = 500;
/** Zusatzmodul im Tarif Starter (in Praxis und Plus enthalten) */
export const CONNECTOR_STARTER_ADDON_CENTS = 900;
export const CONNECTOR_INCLUDED_CALENDARS = 3;

const net = (cents: number) => `${moneyShort(cents)} netto/Monat (${grossLabel(cents)})`;

export const CONNECTOR_PRICES: readonly { name: string; price: string; text: string }[] = [
  { name: "Mit PodoHero Praxis oder Plus", price: "geplant: ohne Aufpreis", text: "Kein zugesagter Leistungsbestandteil – bitte keinen Tarif deswegen buchen." },
  { name: "Mit PodoHero Starter", price: `+${net(CONNECTOR_STARTER_ADDON_CENTS)}`, text: "Geplant als Zusatzmodul." },
  {
    name: "Ohne PodoHero",
    price: net(CONNECTOR_STANDALONE_CENTS),
    text: `Geplant: Abgleich mit Google- oder Outlook-Kalender, bis ${CONNECTOR_INCLUDED_CALENDARS} Kalender. Jeder weitere Kalender ${net(CONNECTOR_EXTRA_CALENDAR_CENTS)}.`,
  },
];

export const CONNECTOR_STATUS_NOTE =
  "In Vorbereitung – noch nicht buchbar. Der Connector startet erst, wenn Doctolib den Zugang zu einer Schnittstelle freigegeben hat. Ob und wann das geschieht, steht nicht fest. PodoHero ist ein unabhängiges Angebot und kein Partner von Doctolib.";

export const CONNECTOR_TRADEMARK_NOTE =
  "Doctolib ist eine Marke ihres jeweiligen Inhabers. PodoHero ist ein unabhängiges Angebot und kein Partner von Doctolib; der Name wird nur beschreibend verwendet.";
