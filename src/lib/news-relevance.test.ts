import { describe, expect, it } from "vitest";
import { cleanNewsUrl, dedupeNews, isRelevantNews, newsSnippet, normalizeNewsTitle, relevanceScore, stripPublisherSuffix } from "./news-relevance";
import { categorizeNews, isPodiatrySourceName, NEWS_SOURCES, newsSourceLabel } from "./news-sources";
import { parseFeed } from "./rss";

describe("Podologie-Relevanzfilter", () => {
  const relevant = [
    "Podologen sind Goldstaub auf dem Lande: Warum fünf Mark Jessica Schneiders Lebenstraum neu entfacht haben - Nordkurier",
    "Wer zahlt bei Diabetes medizinische Fußpflege und Reha? - Apotheken Umschau",
    "Podologie – neue Preise ab 1. Juli 2023 - Kassenärztliche Vereinigung Hamburg",
    "Diabetisches Fußsyndrom: Risikopass soll unnötige Amputationen vermeiden - Deutsches Ärzteblatt",
    "Nagelspange: eine Alternative zur Operation - AerzteZeitung.de",
    "Eingewachsener Zehennagel - Gesundheitsinformation.de",
    "Fotos: Podologin aus Herzberg fertigt Nagelspange - Harzkurier",
    "Änderungen durch das GKV-BStabG betreffen alle Heilmittelberufe, auch die Podologie",
    "Heilmittelerbringer fordern höhere Vergütung",
    "Onychomykose: Neue Leitlinie zur Therapie des Nagelpilzes",
    "Hühnerauge entfernen: Wann zur Fußpflege?",
    "Hallux valgus: Wann helfen Einlagen, wann die OP?",
    "Unguis incarnatus – konservative Therapie mit Nagelkorrekturspange",
    "Diabetische Fußulzera: Druckbelastung und Entlastung",
  ];
  const irrelevant = [
    "Lukas Podolski beendet Karriere beim Górnik Zabrze",
    "Podolski-Döner eröffnet neue Filiale in Köln",
    "Muskelinvasives Urothelkarzinom: Neue perioperative Therapieoption mit guten Ergebnissen",
    "Mammographie-Screening künftig auch für Frauen von 45 bis 49 Jahren – GBA passt Früherkennungsprogramm an",
    "Arzneimittel-Richtlinie/Anlage IX: Everolimus, Gruppe 1, in Stufe 1",
    "CGM-System kann auch ohne ICT sinnvoll sein",
    "DFS: Fluglotsen melden Rekord im deutschen Luftraum",
    "Bundesregierung bei Plastiksteuer weiter uneinig",
    "Fuß vom Gas: Polizei kontrolliert Raser",
    "Hufpflege beim Pferd: Was Hufschmiede raten",
  ];
  it.each(relevant)("lässt durch (allgemeine Quelle): %s", (t) => expect(isRelevantNews(t, false)).toBe(true));
  it.each(irrelevant)("verwirft (allgemeine Quelle): %s", (t) => expect(isRelevantNews(t, false)).toBe(false));

  it("Fachquellen passieren immer – außer harten Fehltreffern", () => {
    expect(isRelevantNews("Ausgebrannt? Nicht mit mir!", true)).toBe(true);
    expect(isRelevantNews("Ausgebrannt? Nicht mit mir!", false)).toBe(false);
    expect(isRelevantNews("Podolski besucht Praxis", true)).toBe(false);
  });

  it("Heilmittel allein reicht nicht, mit Fußbezug schon", () => {
    expect(isRelevantNews("Neuer Höchststand bei Heilmittelausgaben", false)).toBe(false);
    expect(isRelevantNews("Heilmittel-Richtlinie: G-BA ändert Regeln für Podologie", false)).toBe(true);
    expect(relevanceScore("Heilmittel-Richtlinie: Diabetischer Fuß und DFS")).toBeGreaterThan(relevanceScore("Heilmittel-Richtlinie"));
  });

  it("kennt Fach- und allgemeine Quellen", () => {
    expect(isPodiatrySourceName("Verband Deutscher Podologen (VDP)")).toBe(true);
    expect(isPodiatrySourceName("Deutsches Ärzteblatt")).toBe(false);
    expect(isPodiatrySourceName("Nordkurier (via Google News)")).toBe(false);
    expect(NEWS_SOURCES.every((s) => s.verified)).toBe(true);
    const gn = NEWS_SOURCES.find((s) => s.aggregator)!;
    expect(newsSourceLabel(gn, "Nordkurier")).toBe("Nordkurier (via Google News)");
    expect(categorizeNews("Podologie – neue Preise und Vergütung")).toBe("Recht & Abrechnung");
  });
});

describe("News-Dedupe & Bereinigung", () => {
  it("entfernt Tracking-Parameter und Fragment", () => {
    expect(cleanNewsUrl("https://example.org/a?utm_source=rss&utm_medium=feed&id=7#top")).toBe("https://example.org/a?id=7");
    expect(cleanNewsUrl("https://news.google.com/rss/articles/CBMi123?oc=5")).toBe("https://news.google.com/rss/articles/CBMi123");
    expect(cleanNewsUrl("https://example.org/b?fbclid=x&gclid=y")).toBe("https://example.org/b");
    expect(cleanNewsUrl("kein link")).toBe("kein link");
  });

  it("normalisiert Titel (Herausgeber-Anhang, Groß/klein, Satzzeichen, ß)", () => {
    expect(stripPublisherSuffix("Mehr Podologie – weniger Amputationen - Diabetes News Media AG", "Diabetes News Media AG")).toBe("Mehr Podologie – weniger Amputationen");
    expect(normalizeNewsTitle("Mehr Podologie – weniger Amputationen - Diabetes News Media AG", "Diabetes News Media AG")).toBe(normalizeNewsTitle("Mehr Podologie: weniger Amputationen!"));
    expect(normalizeNewsTitle("Fußpflege")).toBe("fusspflege");
  });

  it("entfernt Dubletten über Feeds hinweg (Link oder Titel), erstes Vorkommen gewinnt", () => {
    const items = [
      { id: 1, url: "https://podologie.de/fussulzera/", title: "Diabetische Fußulzera: Druckbelastung und Entlastung" },
      { id: 2, url: "https://podologie.de/fussulzera/?utm_source=newsletter", title: "Andere Überschrift" },
      { id: 3, url: "https://news.google.com/rss/articles/XYZ?oc=5", title: "Diabetische Fußulzera – Druckbelastung und Entlastung - podologie.de", publisher: "podologie.de" },
      { id: 4, url: "https://news.google.com/rss/articles/ABC?oc=5", title: "Nagelspange: eine Alternative zur Operation - AerzteZeitung.de", publisher: "AerzteZeitung.de" },
      { id: 5, url: "https://news.google.com/rss/articles/ABC", title: "Nagelspange: eine Alternative zur Operation - AerzteZeitung.de", publisher: "AerzteZeitung.de" },
    ];
    expect(dedupeNews(items).map((i) => i.id)).toEqual([1, 4]);
  });

  it("Anrisstext: gekürzt, ohne Titelwiederholung", () => {
    const long = "Wort ".repeat(200);
    const s = newsSnippet(long, "Titel");
    expect(s.length).toBeLessThanOrEqual(282);
    expect(s.endsWith("…")).toBe(true);
    expect(newsSnippet("Podologie bei MS AMSEL.de", "Podologie bei MS - AMSEL.de")).toBe("");
    expect(newsSnippet("Kurzer Anriss.", "Titel")).toBe("Kurzer Anriss.");
  });

  it("übernimmt Herausgeber aus Google-News-<source> und bevorzugt den Anriss vor dem Volltext", () => {
    const xml = `<rss><channel><item><title>Podologie bei MS - AMSEL.de</title><link>https://news.google.com/rss/articles/X?oc=5</link><source url="https://www.amsel.de">AMSEL.de</source><description>Kurz</description><content:encoded><![CDATA[<p>Langer Volltext</p>]]></content:encoded></item></channel></rss>`;
    expect(parseFeed(xml)[0]).toMatchObject({ publisher: "AMSEL.de", text: "Kurz" });
  });
});
