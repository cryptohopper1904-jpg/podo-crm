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
  it("Rechenzeit begrenzt: 20.000 Namen, 80-Zeichen-Suchtext, lange Namen (< 150 ms)", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({
      id: String(i),
      lastName: `Nachname${i.toString(36)}-Doppelname-${"x".repeat(i % 60)}`,
      firstName: `Vorname${i % 97} Zweitname ${"y".repeat(i % 50)}`,
    }));
    many.splice(1_000, 0, { id: "hit", lastName: "Hoffmann", firstName: "Ilse" });
    const query = "Hofmann Ilse " + "abcdefghij".repeat(7);
    expect(query.length).toBeGreaterThanOrEqual(80);
    closestNames("Hofmann", many.slice(0, 500)); // Aufwärmen (JIT)
    let t = performance.now();
    closestNames(query, many);
    const long = performance.now() - t;
    t = performance.now();
    const r = closestNames("Hofmann", many);
    const short = performance.now() - t;
    expect(r[0].id).toBe("hit");
    expect(long).toBeLessThan(150);
    expect(short).toBeLessThan(150);
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
