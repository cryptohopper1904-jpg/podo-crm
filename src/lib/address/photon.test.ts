import { describe, expect, it } from "vitest";
import { buildPhotonUrl, citiesForZip, expandAbbreviations, firstCoordinate, normalizePhoton, typedHouseNumber, validateQuery, validateZip } from "./photon";

/** gekürzte, echte Photon-Antwortform (GeoJSON FeatureCollection) */
const FIXTURE = {
  type: "FeatureCollection",
  features: [
    {
      geometry: { type: "Point", coordinates: [13.0446, 52.3906] },
      properties: { osm_key: "place", osm_value: "house", type: "house", street: "Friedrich-Herder-Straße", housenumber: "12", postcode: "14467", city: "Potsdam", district: "Nauener Vorstadt", countrycode: "DE", country: "Deutschland" },
    },
    {
      geometry: { type: "Point", coordinates: [13.0446, 52.3906] },
      properties: { osm_key: "place", type: "house", street: "Friedrich-Herder-Straße", housenumber: "12", postcode: "14467", city: "Potsdam", countrycode: "DE" },
    },
    {
      geometry: { type: "Point", coordinates: [13.04, 52.39] },
      properties: { osm_key: "highway", osm_value: "residential", type: "street", name: "Friedrich-Herder-Straße", postcode: "14467;14469", city: "Potsdam", countrycode: "DE" },
    },
    {
      geometry: { type: "Point", coordinates: [11.5, 48.1] },
      properties: { osm_key: "highway", type: "street", name: "Herderstraße", postcode: "86150", locality: "Bärenkeller", county: "Augsburg", countrycode: "DE" },
    },
    { properties: { type: "street", name: "Herderstraße", postcode: "1010", city: "Wien", countrycode: "AT" } },
    { properties: { type: "house", housenumber: "3", postcode: "14467", city: "Potsdam", countrycode: "DE" } },
    { properties: { type: "street", name: "Ohne Ort", countrycode: "DE" } },
    "kaputt",
  ],
};

describe("normalizePhoton", () => {
  it("wandelt Photon-GeoJSON in Straße/Hausnr./PLZ/Ort um, dedupliziert und filtert", () => {
    expect(normalizePhoton(FIXTURE)).toEqual([
      { street: "Friedrich-Herder-Straße", houseNumber: "12", zip: "14467", city: "Potsdam", district: "Nauener Vorstadt", label: "Friedrich-Herder-Straße 12, 14467 Potsdam" },
      { street: "Friedrich-Herder-Straße", zip: "14467", city: "Potsdam", label: "Friedrich-Herder-Straße, 14467 Potsdam" },
      { street: "Herderstraße", zip: "86150", city: "Bärenkeller", label: "Herderstraße, 86150 Bärenkeller" },
    ]);
  });

  it("verträgt kaputte Antworten", () => {
    for (const j of [null, undefined, "x", 42, {}, { features: "x" }, { features: [null, 1] }]) expect(normalizePhoton(j)).toEqual([]);
  });

  it("citiesForZip liefert eindeutige Orte zur PLZ", () => {
    expect(citiesForZip(FIXTURE, "14467")).toEqual(["Potsdam"]);
    expect(citiesForZip(FIXTURE, "14469")).toEqual(["Potsdam"]);
    expect(citiesForZip(FIXTURE, "99999")).toEqual([]);
    expect(citiesForZip({ features: [{ properties: { type: "city", name: "Teltow", postcode: "14513", countrycode: "DE" } }] }, "14513")).toEqual(["Teltow"]);
  });

  it("firstCoordinate liest lat/lon", () => {
    expect(firstCoordinate(FIXTURE)).toEqual({ lat: 52.3906, lon: 13.0446 });
    expect(firstCoordinate({ features: [] })).toBeNull();
  });
});

describe("Anfrage-Prüfung", () => {
  it("validateQuery: 3–120 Zeichen, Steuerzeichen/Leerraum bereinigt", () => {
    expect(validateQuery("ab")).toBeNull();
    expect(validateQuery("  a b ")).toBe("a b");
    expect(validateQuery("Friedrich-Herder-Str.")).toBe("Friedrich-Herder-Str.");
    expect(validateQuery("x".repeat(120))).toHaveLength(120);
    expect(validateQuery("x".repeat(121))).toBeNull();
    expect(validateQuery("---")).toBeNull();
    expect(validateQuery("Haupt\u0000str\n 5")).toBe("Haupt str 5");
    expect(validateQuery(undefined)).toBeNull();
    expect(validateQuery(["abc"])).toBeNull();
  });

  it("validateZip: genau fünf Ziffern", () => {
    expect(validateZip("14467")).toBe("14467");
    expect(validateZip("1446")).toBeNull();
    expect(validateZip("144678")).toBeNull();
    expect(validateZip("1446a")).toBeNull();
  });

  it("Abkürzung Str. wird ausgeschrieben", () => {
    expect(expandAbbreviations("Friedrich-Herder-Str.")).toBe("Friedrich-Herder-Straße");
    expect(expandAbbreviations("Hauptstr. 5")).toBe("Hauptstraße 5");
    expect(expandAbbreviations("Hauptstr 5")).toBe("Hauptstraße 5");
    expect(expandAbbreviations("Strandweg 3")).toBe("Strandweg 3");
    expect(expandAbbreviations("Hauptstraße 5")).toBe("Hauptstraße 5");
  });

  it("typedHouseNumber erkennt Hausnummern, aber keine PLZ", () => {
    expect(typedHouseNumber("Friedrich-Herder-Str. 12")).toBe("12");
    expect(typedHouseNumber("Hauptstr. 12a")).toBe("12a");
    expect(typedHouseNumber("Hauptstr. 12 a, Potsdam")).toBe("12a");
    expect(typedHouseNumber("Hauptstr. 4-6")).toBe("4-6");
    expect(typedHouseNumber("Hauptstr. 14467 Potsdam")).toBeUndefined();
    expect(typedHouseNumber("Friedrich-Herder-Str.")).toBeUndefined();
  });

  it("buildPhotonUrl: Deutschland-bbox, Sprache, Ebenen, optionale Ortsgewichtung", () => {
    const u = new URL(buildPhotonUrl("https://photon.komoot.io", { q: "Hauptstraße 5", lat: 52.39061, lon: 13.04462 }));
    expect(u.origin + u.pathname).toBe("https://photon.komoot.io/api/");
    expect(u.searchParams.get("q")).toBe("Hauptstraße 5");
    expect(u.searchParams.get("lang")).toBe("de");
    expect(u.searchParams.get("limit")).toBe("6");
    expect(u.searchParams.get("bbox")).toBe("5.87,47.27,15.04,55.06");
    expect(u.searchParams.getAll("layer")).toEqual(["house", "street"]);
    expect(u.searchParams.get("lat")).toBe("52.3906");
    const plain = new URL(buildPhotonUrl("https://geo.example.de/", { q: "abc" }));
    expect(plain.pathname).toBe("/api/");
    expect(plain.searchParams.has("lat")).toBe(false);
  });
});
