import { describe, expect, it } from "vitest";
import { erstelleBegleitzettel } from "./begleitzettel";
import { erzeugeNutzdatendatei } from "./nutzdatei";
import { bildeAbrechnungsfall } from "./adapter";
import { KEIN_KRYPTOMODUL } from "./sicherheit";
import { TEST_IK, testDatei, testFall2 } from "./fixtures/testdaten";

describe("Begleitzettel für Urbelege (Anlage 4)", () => {
  it("je Gesamtrechnung ein Zettel mit allen Pflichtinhalten", () => {
    const d = testDatei();
    const z = erstelleBegleitzettel(d, erzeugeNutzdatendatei(d), (ik) => ({ ik: TEST_IK.belegannahme, name: `Belegannahme für ${ik}` }));
    expect(z).toHaveLength(2);
    expect(z[0]).toEqual({
      titel: "Begleitzettel für Urbelege",
      kasse: { ik: TEST_IK.kasse, name: "Testkasse Nord" },
      rechnungssteller: { ik: TEST_IK.praxis, name: "Podologie Testpraxis", anschrift: { strasse: "Teststraße 1", plz: "10115", ort: "Berlin" } },
      rechnungsnummer: { sammel: "2026-10/0001", einzel: "0" },
      rechnungsdatum: "2026-11-02",
      anzahlUrbelege: 1,
      ersteBelegnummer: undefined,
      letzteBelegnummer: undefined,
      belegreihenfolge: ["1"],
      belegannahmestelle: { ik: TEST_IK.belegannahme, name: `Belegannahme für ${TEST_IK.kasse}` },
    });
  });

  it("Abrechnungsstelle: erste und letzte Belegnummer; eVO zählt nicht als Papierbeleg", () => {
    const d = testDatei({
      rechnungsart: "2",
      absender: { ik: TEST_IK.abrechnungsstelle, art: "A", name: "Test-Abrechnungsstelle", anschrift: { strasse: "Weg 1", plz: "10115", ort: "Berlin" } },
    });
    const faelle = d.leistungserbringer[0].kostentraeger[0].rechnungen[1].faelle;
    faelle.push({ ...testFall2(), belegnummer: "3" }, { ...testFall2(), belegnummer: "4", eVoId: "160.000.000.000.000.01" });
    const z = erstelleBegleitzettel(d, erzeugeNutzdatendatei(d));
    expect(z[1]).toMatchObject({ rechnungssteller: { ik: TEST_IK.abrechnungsstelle }, anzahlUrbelege: 2, ersteBelegnummer: "2", letzteBelegnummer: "3", belegreihenfolge: ["2", "3"] });
  });
});

describe("Adapter PodoHero → § 302", () => {
  it("meldet fehlende Pflichtangaben, statt sie zu erfinden", () => {
    const { fall, fehlendeAngaben } = bildeAbrechnungsfall(
      "1",
      { id: "v1", issuedAt: "2026-10-01", diagnosisGroup: "DF", homeVisit: false, urgent: false, copaymentExempt: true, therapyReportRequested: false, source: "paper" },
      { lastName: "Test", firstName: "Toni", birthDate: "1960-01-01", insuranceNumber: "X000000003" },
      [{ date: "2026-10-05", position: "99901", units: 1, priceCents: 3555 }],
      {},
    );
    expect(fehlendeAngaben).toEqual([
      "Kennzeichen Verordnungsart (Anlage 3, 8.1.12)",
      "Leitsymptomatik (a/b/c/patientenindividuell)",
      "Versichertenstatus von der Verordnung",
      "IK der Krankenkasse von der Verordnung",
      "ICD-10-Code oder Diagnosetext",
    ]);
    expect(fall.zuzahlungskennzeichen).toBe("1");
    expect(fall.verordnung.therapiefrequenz).toBe(0);
    expect(fall.beleginformation).toBe("1");
  });
});

describe("Sicherheit (nur Schnittstelle)", () => {
  it("ohne Kryptomodul ist kein Versand möglich", async () => {
    await expect(KEIN_KRYPTOMODUL.signiereUndVerschluessele({ nutzdaten: new Uint8Array(), absender: { ik: TEST_IK.praxis }, empfaenger: { ik: TEST_IK.davMitEntschluesselung } })).rejects.toThrow("noch nicht umgesetzt");
  });
});
