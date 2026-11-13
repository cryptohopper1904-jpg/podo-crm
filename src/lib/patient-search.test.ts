import { describe, expect, it } from "vitest";
import {
  cleanQuery,
  closestNames,
  editDistance,
  FUZZY_MAX_CANDIDATES,
  FUZZY_MAX_CHARS,
  fuzzyEligible,
  nameScore,
  normalizeName,
  prepareQuery,
  queryTokens,
  similarity,
  suggestedQuery,
  trigramSimilarity,
} from "./patient-search";

describe("Patientensuche: Normalisierung", () => {
  it("Umlaute, Akzente, ß und Satzzeichen", () => {
    expect(normalizeName("  Müller-Lüdenscheidt ")).toBe("muller ludenscheidt");
    expect(normalizeName("Weiß")).toBe("weiss");
    expect(normalizeName("José")).toBe("jose");
  });
  it("Suchtext: Länge 2–80, Leerraum zusammengefasst", () => {
    expect(cleanQuery("a")).toBeNull();
    expect(cleanQuery(" Mu ")).toBe("Mu");
    expect(cleanQuery("Erika   Muster")).toBe("Erika Muster");
    expect(cleanQuery("x".repeat(81))).toBeNull();
    expect(cleanQuery(42)).toBeNull();
  });
  it("Suchwörter: Komma oder Leerzeichen, höchstens 4", () => {
    expect(queryTokens("Muster, Erika")).toEqual(["Muster", "Erika"]);
    expect(queryTokens("a b c d e")).toHaveLength(4);
  });
  it("„Meinten Sie“ nur ab 3 Buchstaben und nicht für reine Ziffern", () => {
    expect(fuzzyEligible("Mu")).toBe(false);
    expect(fuzzyEligible("1234")).toBe(false);
    expect(fuzzyEligible("12.03.1950")).toBe(false);
    expect(fuzzyEligible("Mus")).toBe(true);
  });
});

describe("Patientensuche: Ähnlichkeit", () => {
  it("Damerau-Levenshtein: Vertauschung zählt 1", () => {
    expect(editDistance("Muster", "Mustre")).toBe(1);
    expect(editDistance("Meier", "Maier")).toBe(1);
    expect(editDistance("Schmidt", "Schmitt")).toBe(1);
    expect(editDistance("Müller", "Mueller")).toBe(1); // ü→u, dann ein e zu viel
    expect(editDistance("", "abc")).toBe(3);
  });
  it("Trigramme wie pg_trgm", () => {
    expect(trigramSimilarity("Muster", "Muster")).toBe(1);
    expect(trigramSimilarity("Muster", "Xyz")).toBe(0);
    expect(trigramSimilarity("Schneider", "Schnieder")).toBeGreaterThan(0.3);
  });
  it("typische Tippfehler sind ähnlich, fremde Namen nicht", () => {
    expect(similarity("Schmitt", "Schmidt")).toBeGreaterThan(0.7);
    expect(similarity("Mustre", "Muster")).toBeGreaterThan(0.8);
    expect(similarity("Wagner", "Becker")).toBeLessThan(0.45);
  });
  it("Name in beliebiger Reihenfolge, Vorname allein", () => {
    const p = { lastName: "Musterfrau", firstName: "Erika" };
    expect(nameScore("Erika Musterfrau", p)).toBe(1);
    expect(nameScore("Musterfrau Erika", p)).toBe(1);
    expect(nameScore("Erica", p)).toBeGreaterThan(0.75);
  });
});

describe("Patientensuche: „Meinten Sie“", () => {
  const people = [
    { id: "1", lastName: "Schmidt", firstName: "Hans" },
    { id: "2", lastName: "Schmitz", firstName: "Gerda" },
    { id: "3", lastName: "Wagner", firstName: "Paula" },
    { id: "4", lastName: "Becker", firstName: "Karl" },
    { id: "5", lastName: "Musterfrau", firstName: "Erika" },
  ];
  it("ähnlichste zuerst, unpassende raus", () => {
    const r = closestNames("Schmitt", people);
    expect(r.map((x) => x.id)).toEqual(["1", "2"]);
    expect(r[0].score).toBeGreaterThanOrEqual(r[1].score); // beide 1 Zeichen entfernt → Gleichstand, dann alphabetisch
  });
  it("direkte Treffer werden ausgelassen, Limit greift", () => {
    expect(closestNames("Schmitt", people, { exclude: new Set(["1"]) }).map((x) => x.id)).toEqual(["2"]);
    expect(closestNames("Schmitt", people, { limit: 1 })).toHaveLength(1);
  });
  it("vollständiger Name mit Tippfehler", () => {
    const r = closestNames("Ericka Mustrefrau", people);
    expect(r[0].id).toBe("5");
    expect(suggestedQuery("Ericka Mustrefrau", r[0])).toBe("Erika Musterfrau");
  });
  it("Vorschlagstext: Nachname oder Vorname, je nachdem was gemeint war", () => {
    expect(suggestedQuery("Schmitt", people[0])).toBe("Schmidt");
    expect(suggestedQuery("Paulla", people[2])).toBe("Paula");
  });
  /**
   * Laufzeit-Grenzen: fangen Regressionen in der Größenordnung des alten Problems (Sekunden je Anfrage), bleiben
   * aber unter CI-Last stabil – 1 Aufwärmlauf, dann Median aus 5 Läufen (< 1000 ms) und harte Obergrenze je Lauf
   * (< 2000 ms). Typisch sind es 10–30 ms. Die Kandidaten-Obergrenze selbst prüft der Test darunter deterministisch.
   */
  const MEDIAN_LIMIT_MS = 1_000;
  const HARD_LIMIT_MS = 2_000;
  function timed(fn: () => void, runs = 5): { median: number; max: number } {
    fn(); // Aufwärmen (JIT)
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      fn();
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    return { median: ms[Math.floor(runs / 2)], max: ms[runs - 1] };
  }

  it("Rechenzeit begrenzt: 20.000 übergebene Namen (davon ≤ 2000 bewertet), 80-Zeichen-Suchtext", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({
      id: String(i),
      lastName: `Nachname${i.toString(36)}-Doppelname-${"x".repeat(i % 60)}`,
      firstName: `Vorname${i % 97} Zweitname ${"y".repeat(i % 50)}`,
    }));
    many.splice(1_000, 0, { id: "hit", lastName: "Hoffmann", firstName: "Ilse" });
    const query = "Hofmann Ilse " + "abcdefghij".repeat(7);
    expect(query.length).toBeGreaterThanOrEqual(80);
    expect(closestNames("Hofmann", many)[0].id).toBe("hit");
    for (const q of [query, "Hofmann"]) {
      const { median, max } = timed(() => closestNames(q, many));
      expect(median, q).toBeLessThan(MEDIAN_LIMIT_MS);
      expect(max, q).toBeLessThan(HARD_LIMIT_MS);
    }
  });
  it("Worst Case: 2000 ähnliche 40-Zeichen-Namen, 40-Zeichen-Suchtext", () => {
    // alle Namen teilen Trigramme und Länge mit dem Suchtext → keine Schranke greift früh, volle Levenshtein-Läufe
    const base = "abcdefghijklmnopqrst";
    const vary = (i: number) => base.slice(0, 19) + String.fromCharCode(97 + (i % 26));
    const many = Array.from({ length: FUZZY_MAX_CANDIDATES }, (_, i) => ({ id: String(i), lastName: vary(i), firstName: vary(i + 7) }));
    expect(`${many[0].firstName} ${many[0].lastName}`.length).toBe(FUZZY_MAX_CHARS + 1);
    const query = `${base} ${base}`.slice(0, FUZZY_MAX_CHARS);
    expect(closestNames(query, many).length).toBeGreaterThan(0);
    const { median, max } = timed(() => closestNames(query, many));
    expect(median).toBeLessThan(MEDIAN_LIMIT_MS);
    expect(max).toBeLessThan(HARD_LIMIT_MS);
  });
  it("bewertet höchstens FUZZY_MAX_CANDIDATES Kandidaten", () => {
    const many = Array.from({ length: FUZZY_MAX_CANDIDATES + 10 }, (_, i) => ({ id: String(i), lastName: "Becker", firstName: null }));
    many.push({ id: "spaet", lastName: "Hoffmann", firstName: null });
    expect(closestNames("Hofmann", many)).toEqual([]);
  });
  it("Suchtext wird für den Vergleich gekürzt", () => {
    expect(prepareQuery("a".repeat(200)).norm.length).toBe(FUZZY_MAX_CHARS);
  });
});
