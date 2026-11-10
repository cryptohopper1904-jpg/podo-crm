import { describe, expect, it } from "vitest";
import { dedupeLeads, detectSeparator, nameZipKey, parseLeadCsv, splitCsv } from "./csv";

describe("CSV: Zerlegen", () => {
  it("Anführungszeichen, doppelte Anführungszeichen, Umbrüche in Feldern, CRLF", () => {
    expect(splitCsv('a;"b;c";"d ""x"""\r\n"e\nf";g;h\r\n', ";")).toEqual([
      ["a", "b;c", 'd "x"'],
      ["e\nf", "g", "h"],
    ]);
  });
  it("Trennzeichen aus der Kopfzeile", () => {
    expect(detectSeparator("name;email;city")).toBe(";");
    expect(detectSeparator("name,email,city")).toBe(",");
  });
});

describe("parseLeadCsv", () => {
  it("liest Komma-CSV mit BOM, normalisiert E-Mail, Website und Entfernung", () => {
    const csv = "﻿name,email,phone,website,street,zip,city,distance_km,source,notes\nPodologie Am Markt,Info@Praxis.Example,0301234,praxis.example,Markt 1,12345,Musterstadt,\"3,4\",OpenStreetMap,Notiz\n";
    const { rows, error } = parseLeadCsv(csv);
    expect(error).toBeUndefined();
    expect(rows).toEqual([
      {
        line: 2,
        lead: {
          name: "Podologie Am Markt",
          contactPerson: null,
          email: "info@praxis.example",
          phone: "0301234",
          website: "https://praxis.example/",
          street: "Markt 1",
          zip: "12345",
          city: "Musterstadt",
          distanceKm: 3.4,
          source: "OpenStreetMap",
          notes: "Notiz",
        },
      },
    ]);
  });

  it("Semikolon-CSV, deutsche Spaltennamen, Fehlerzeilen mit Zeilennummer", () => {
    const csv = "Praxis;E-Mail;PLZ;Ort;distance_km\nA;a@x.de;1;O;\n;b@x.de;2;O;\nC;kaputt;3;O;\nD;;4;O;viel\n";
    const { rows } = parseLeadCsv(csv);
    expect(rows[0]).toMatchObject({ line: 2, lead: { name: "A", email: "a@x.de", zip: "1" } });
    expect(rows[1]).toEqual({ line: 3, error: "Name fehlt" });
    expect(rows[2]).toMatchObject({ line: 4, error: expect.stringMatching(/Ungültige E-Mail/) });
    expect(rows[3]).toMatchObject({ line: 5, error: expect.stringMatching(/distance_km/) });
  });

  it("ohne Spalte name oder leer → Fehler", () => {
    expect(parseLeadCsv("email,city\na@b.de,X").error).toMatch(/name/);
    expect(parseLeadCsv("   ").error).toMatch(/leer/);
  });

  it("javascript:-Website wird verworfen", () => {
    const { rows } = parseLeadCsv("name,website\nX,javascript:alert(1)\n");
    expect(rows[0]).toMatchObject({ lead: { website: null } });
  });
});

describe("dedupeLeads", () => {
  const { rows } = parseLeadCsv(
    ["name;email;zip", "Praxis A;a@x.de;111", "Praxis B;A@X.DE;222", "praxis  a;;111", "Praxis C;c@x.de;333", "Praxis D;d@x.de;444", "Praxis E;gesperrt@x.de;555", "Praxis F;;666"].join("\n"),
  );
  const d = dedupeLeads(rows, { emails: new Set(["d@x.de"]), nameZips: new Set([nameZipKey("Praxis F", "666")]), suppressed: new Set(["gesperrt@x.de"]) });

  it("E-Mail (ohne Groß/Klein), Name+PLZ, Bestand und Sperrliste", () => {
    expect(d.map((x) => [x.lead?.name, x.action === "neu" ? "neu" : x.reason])).toEqual([
      ["Praxis A", "neu"],
      ["Praxis B", "E-Mail bereits vorhanden"],
      ["praxis  a", "Name und PLZ bereits vorhanden"],
      ["Praxis C", "neu"],
      ["Praxis D", "E-Mail bereits vorhanden"],
      ["Praxis E", "Auf der Sperrliste (abgemeldet)"],
      ["Praxis F", "Name und PLZ bereits vorhanden"],
    ]);
  });
});
