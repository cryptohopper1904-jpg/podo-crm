/** eVerordnung (Heilmittel, FHIR R4): defensiver Parser auf erfundenen Beispiel-Bundles. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { condensedImportData, MAX_BUNDLE_BYTES, parseEverordnungText, positionsFrom } from "./parse";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("eVerordnung-Parser", () => {
  it("vollständiges KBV-ähnliches Bundle (DF)", () => {
    const r = parseEverordnungText(fixture("hmv-df-komplett.json"));
    if (!r.ok) throw new Error(r.error);
    const s = r.summary;
    expect(s.externalRef).toBe("170.000.000.000.001.01");
    expect(s.issuedAt).toBe("2026-10-28");
    expect(s.patient).toMatchObject({ lastName: "Musterfrau", firstName: "Erika", birthDate: "1950-02-01", kvnr: "A123456780", gender: "female", zip: "12345" });
    expect(s.coverage).toEqual({ insurerName: "Test-Krankenkasse (erfunden)", ik: "100000000", kind: "gkv", copaymentExempt: false });
    expect(s.practitioner).toEqual({ name: "Dr. med. Hans Beispiel", lanr: "999999901" });
    expect(s.organization).toEqual({ name: "Praxis Dr. Beispiel (Testdaten)", bsnr: "999999900" });
    expect(s.diagnoses.map((d) => d.code)).toEqual(["E11.74", "G63.2"]);
    expect(s.diagnosisGroup).toBe("DF");
    expect(s.diagnosisGroupInferred).toBe(false);
    expect(s.leitsymptomatik).toMatch(/^a – Schädigung der Haut/);
    expect(s.remedies).toEqual([{ code: "78100", display: "Podologische Komplexbehandlung", units: 6 }]);
    expect(s.units).toBe(6);
    expect(s.frequency).toBe("1x alle 4-6 Wochen");
    expect(s).toMatchObject({ homeVisit: false, urgent: false, therapyReport: true, note: "Erfundene Testverordnung" });
    expect(s.warnings).toEqual([]);
    expect(positionsFrom(s, 6)).toEqual([{ position: "78100", label: "Podologische Komplexbehandlung", units: 6 }]);
  });

  it("abweichende Struktur (MedicationRequest-ähnlich, ohne Identifier/Coverage) wird defensiv gelesen", () => {
    const r = parseEverordnungText(fixture("hmv-ui-minimal.json"));
    if (!r.ok) throw new Error(r.error);
    const s = r.summary;
    expect(s.externalRef).toBe("bundle-ui-0002");
    expect(s.issuedAt).toBe("2026-11-03");
    expect(s.diagnosisGroup).toBe("UI2");
    expect(s.diagnoses).toEqual([{ code: "L60.0", display: "Unguis incarnatus" }]);
    expect(s.remedies).toEqual([{ code: null, display: "Nagelkorrekturspange, mehrteilig", units: 4 }]);
    expect(s).toMatchObject({ units: 4, frequency: "1x alle 1-4 Wochen", homeVisit: true, urgent: true });
    expect(s.patient).toMatchObject({ lastName: "Mustermann", kvnr: null });
    expect(s.practitioner.lanr).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/KVNR/);
    expect(s.warnings.join(" ")).toMatch(/LANR/);
    expect(positionsFrom(s, 4)).toEqual([{ label: "Nagelkorrekturspange, mehrteilig", units: 4 }]);
  });

  it("ICD E11.74 ohne Diagnosegruppe → DF als markierter Vorschlag", () => {
    const b = JSON.parse(fixture("hmv-df-komplett.json"));
    const sr = b.entry[1].resource;
    sr.extension = sr.extension.filter((e: { url: string }) => !e.url.includes("Diagnosegruppe"));
    const r = parseEverordnungText(JSON.stringify(b));
    if (!r.ok) throw new Error(r.error);
    expect(r.summary.diagnosisGroup).toBe("DF");
    expect(r.summary.diagnosisGroupInferred).toBe(true);
    expect(r.summary.warnings.join(" ")).toMatch(/vorgeschlagen/);
  });

  it("verdichtete Import-Daten enthalten keine Rohdaten, keinen Namen und keine Adresse", () => {
    const r = parseEverordnungText(fixture("hmv-df-komplett.json"));
    if (!r.ok) throw new Error(r.error);
    const d = JSON.stringify(condensedImportData(r.summary, new Date("2026-11-08T10:00:00Z")));
    expect(d).not.toContain("Musterfrau");
    expect(d).not.toContain("Beispielweg");
    expect(d).not.toContain("entry");
    expect(d).toContain("E11.74");
    expect(d.length).toBeLessThan(3000);
  });

  it("lehnt ungültige Eingaben freundlich ab", () => {
    expect(parseEverordnungText("kein json")).toEqual({ ok: false, error: expect.stringMatching(/JSON/) });
    expect(parseEverordnungText('{"resourceType":"Patient"}')).toEqual({ ok: false, error: expect.stringMatching(/Bundle/) });
    expect(parseEverordnungText('{"resourceType":"Bundle","id":"x","entry":[]}')).toEqual({ ok: false, error: expect.stringMatching(/keine Einträge/) });
    expect(parseEverordnungText('{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"ServiceRequest"}}]}')).toEqual({ ok: false, error: expect.stringMatching(/Kennung/) });
    expect(parseEverordnungText('{"resourceType":"Bundle","id":"x","entry":[{"resource":{"resourceType":"Patient"}}]}')).toEqual({ ok: false, error: expect.stringMatching(/Keine Verordnung/) });
    expect(parseEverordnungText(`{"resourceType":"Bundle","id":"x","pad":"${"x".repeat(MAX_BUNDLE_BYTES)}"}`)).toEqual({ ok: false, error: expect.stringMatching(/1 MB/) });
    // falsche Typen in bekannten Feldern führen nicht zum Absturz
    const weird = parseEverordnungText('{"resourceType":"Bundle","id":"x","entry":[{"resource":{"resourceType":"ServiceRequest","code":"falsch"}},{"resource":{"resourceType":"ServiceRequest","code":{"text":"Hornhautabtragung"},"quantityQuantity":{"value":3}}}]}');
    expect(weird.ok && weird.summary.remedies).toEqual([{ code: null, display: "Hornhautabtragung", units: 3 }]);
  });
});
