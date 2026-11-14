import { describe, expect, it } from "vitest";
import { matchPatients, splitNewName } from "./calendar-patient-search";

const P = [
  { id: "1", number: 12, firstName: "Erika", lastName: "Beispiel" },
  { id: "2", number: 7, firstName: "Max", lastName: "Mustermann" },
  { id: "3", number: 105, firstName: "Gabi", lastName: "Probe-Erikson" },
  { id: "4", number: 3, firstName: null, lastName: "Ohnevorname" },
];

describe("matchPatients", () => {
  it("leere Suche: keine Vorschläge", () => {
    expect(matchPatients(P, "  ")).toEqual([]);
  });
  it("Name, Vorname, Nummer; Wortanfang zuerst", () => {
    expect(matchPatients(P, "erik").map((p) => p.id)).toEqual(["1", "3"]);
    expect(matchPatients(P, "105").map((p) => p.id)).toEqual(["3"]);
    expect(matchPatients(P, "7").map((p) => p.id)).toEqual(["2"]);
    expect(matchPatients(P, "OHNE").map((p) => p.id)).toEqual(["4"]);
  });
  it("mehrere Wörter müssen alle passen", () => {
    expect(matchPatients(P, "max muster").map((p) => p.id)).toEqual(["2"]);
    expect(matchPatients(P, "max beispiel")).toEqual([]);
  });
  it("höchstens max Treffer", () => {
    expect(matchPatients(P, "e", 2)).toHaveLength(2);
  });
});

describe("splitNewName", () => {
  it("Vorname Nachname, Nachname, Vorname; nur Nachname; Nummer", () => {
    expect(splitNewName("Erika  Musterfrau")).toEqual({ firstName: "Erika", lastName: "Musterfrau" });
    expect(splitNewName("Anna Maria Beispiel")).toEqual({ firstName: "Anna Maria", lastName: "Beispiel" });
    expect(splitNewName("Beispiel, Erika")).toEqual({ firstName: "Erika", lastName: "Beispiel" });
    expect(splitNewName("Probe")).toEqual({ firstName: "", lastName: "Probe" });
    expect(splitNewName("123")).toEqual({ firstName: "", lastName: "" });
  });
});
