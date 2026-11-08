/**
 * Nachrichtenquellen für „News & Wissen“ (PLAN 4.9). Nur öffentliche Feeds, keine Patientendaten.
 * `verified: false` = Feed-URL noch nicht geprüft (TODO: im Browser öffnen und ggf. korrigieren).
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
  sponsored?: boolean;
}

export const NEWS_SOURCES: NewsSource[] = [
  // TODO: URL prüfen – G-BA bietet RSS-Feeds unter https://www.g-ba.de/service/rss/ an
  { id: "gba", name: "G-BA Pressemitteilungen", url: "https://www.g-ba.de/service/rss/pressemitteilungen/", verified: false, defaultCategory: "Recht & Abrechnung" },
  // TODO: URL prüfen – GKV-Spitzenverband (Presse/Heilmittel)
  { id: "gkv", name: "GKV-Spitzenverband", url: "https://www.gkv-spitzenverband.de/service/rss/rss_pressemitteilungen.xml", verified: false, defaultCategory: "Recht & Abrechnung" },
  { id: "aerzteblatt", name: "Deutsches Ärzteblatt", url: "https://www.aerzteblatt.de/rss/news.asp", verified: false, defaultCategory: "allgemein" },
  // TODO: Fachverbände (z. B. Deutscher Verband für Podologie, ZFD) – Feed-Adressen ermitteln
];

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
