/**
 * Nachrichtenquellen für „News für Podolog:innen“ (PLAN 4.9). Nur öffentliche Feeds, keine Patientendaten.
 * `verified: true` = Feed-URL liefert gültiges RSS/Atom (zuletzt geprüft 2026-11-09).
 * `podiatrySpecific: true` = Fachquelle der Podologie, Meldungen passieren den Relevanzfilter immer;
 * alle anderen Quellen müssen die Schwelle in `news-relevance.ts` erreichen.
 *
 * Geprüft, aber nicht aufgenommen: ZFD (zfd.de, TLS-Fehler/kein Feed), Bundesverband für Podologie (nicht erreichbar),
 * „DER FUSS“ (der-fuss.de, Feed ohne Inhalte), GKV-Spitzenverband (kein RSS mehr), DDG (kein Feed).
 */
import { wordRegex } from "./unicode-regex";
export const NEWS_CATEGORIES = ["Recht & Abrechnung", "Techniken", "Geräte", "Produkte", "Fortbildung", "allgemein"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export interface NewsSource {
  id: string;
  name: string;
  url: string;
  verified: boolean;
  defaultCategory: NewsCategory;
  podiatrySpecific: boolean;
  /** Aggregator (Google News): Herausgeber aus <source> übernehmen, Anzeige „Herausgeber (via Google News)“. */
  aggregator?: boolean;
  sponsored?: boolean;
}

const googleNews = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q).replace(/%20/g, "+")}&hl=de&gl=DE&ceid=DE:de`;

export const NEWS_SOURCES: NewsSource[] = [
  // Fachverband / Fachzeitschrift
  { id: "vdp", name: "Verband Deutscher Podologen (VDP)", url: "https://www.verband-deutscher-podologen.de/feed/", verified: true, defaultCategory: "allgemein", podiatrySpecific: true },
  { id: "podologie-de", name: "PODOLOGIE (Fachzeitschrift)", url: "https://podologie.de/feed/", verified: true, defaultCategory: "Techniken", podiatrySpecific: true },
  // Google-News-Suchen (Relevanzfilter greift)
  { id: "gn-podologie", name: "Google News", url: googleNews(`Podologie OR Podologe OR Podologin OR "medizinische Fußpflege"`), verified: true, defaultCategory: "allgemein", podiatrySpecific: false, aggregator: true },
  { id: "gn-heilmittel", name: "Google News", url: googleNews("Heilmittel Podologie"), verified: true, defaultCategory: "Recht & Abrechnung", podiatrySpecific: false, aggregator: true },
  { id: "gn-dfs", name: "Google News", url: googleNews(`"diabetisches Fußsyndrom"`), verified: true, defaultCategory: "Techniken", podiatrySpecific: false, aggregator: true },
  { id: "gn-nagelspange", name: "Google News", url: googleNews("Nagelkorrekturspange OR Nagelspange OR Nagelkorrektur"), verified: true, defaultCategory: "Techniken", podiatrySpecific: false, aggregator: true },
  // Allgemeine Quellen – nur Meldungen zu Heilmitteln/Podologie/Fuß (Relevanzfilter)
  { id: "gba", name: "G-BA Pressemitteilungen", url: "https://www.g-ba.de/presse/pressemitteilungen-meldungen/letzte-aenderungen/?rss=1", verified: true, defaultCategory: "Recht & Abrechnung", podiatrySpecific: false },
  { id: "gba-beschluesse", name: "G-BA Beschlüsse", url: "https://www.g-ba.de/beschluesse/letzte-aenderungen/?rss=1", verified: true, defaultCategory: "Recht & Abrechnung", podiatrySpecific: false },
  { id: "aerzteblatt", name: "Deutsches Ärzteblatt", url: "https://www.aerzteblatt.de/rss/news.asp", verified: true, defaultCategory: "allgemein", podiatrySpecific: false },
  { id: "diabetes-news", name: "diabetes-news", url: "https://www.diabetes-news.de/feed/", verified: true, defaultCategory: "Techniken", podiatrySpecific: false },
];

/** Gespeicherter Quellenname → podologiespezifisch? (für Filter gespeicherter Meldungen) */
export function isPodiatrySourceName(name: string): boolean {
  return NEWS_SOURCES.some((s) => s.podiatrySpecific && s.name === name);
}

/** Anzeigename der Quelle; bei Aggregatoren mit Herausgeber. */
export function newsSourceLabel(source: NewsSource, publisher?: string | null): string {
  return source.aggregator && publisher ? `${publisher} (via ${source.name})` : source.name;
}

/** Schlagwörter → Kategorie (erste Übereinstimmung gewinnt; Reihenfolge = Priorität). */
const RULES: [NewsCategory, RegExp][] = [
  ["Recht & Abrechnung", wordRegex(String.raw`\b(heilmittel\w*|richtlinie|g-ba|gkv|abrechnung|vergütung|preis(e|liste)|verordnung|gesetz\w*|urteil|telematik|ti-|e-?rezept|datenschutz|dsgvo|steuer\w*|kassen\w*|rahmenvertrag)\b`)],
  ["Fortbildung", wordRegex(String.raw`\b(fortbildung\w*|seminar\w*|kongress\w*|webinar\w*|weiterbildung\w*|kurs(e|en)?|fachtagung|zertifi\w*)\b`)],
  ["Geräte", wordRegex(String.raw`\b(gerät\w*|fräse\w*|sterilisator\w*|autoklav\w*|instrument\w*|absaug\w*|laser\w*|behandlungsstuhl|lupe)\b`)],
  ["Produkte", wordRegex(String.raw`\b(produkt\w*|creme\w*|salbe\w*|einlage\w*|orthes\w*|spange\w*|hersteller|markteinführung|sortiment)\b`)],
  ["Techniken", wordRegex(String.raw`\b(technik\w*|methode\w*|verfahren|studie\w*|leitlinie\w*|wundversorgung|diabetisch\w*|nagelkorrektur|behandlungsansatz)\b`)],
];

export function categorizeNews(text: string, fallback: NewsCategory = "allgemein"): NewsCategory {
  return RULES.find(([, re]) => re.test(text))?.[0] ?? fallback;
}
