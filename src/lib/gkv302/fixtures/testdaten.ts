/**
 * Erfundene Testdaten. Alle IKs beginnen mit „99“ und haben eine gültige Prüfziffer, damit sie als Testwerte
 * erkennbar sind; Positionsnummern „999xx“, Preise und Tarifkennzeichen sind frei erfunden und stammen NICHT aus
 * einem Vertrag oder dem Positionsnummernverzeichnis. Keine echten Personen.
 */
import type { Abrechnungsfall, Nutzdatendatei, Praxis } from "../typen";

export const TEST_IK = {
  praxis: "990010013",
  praxis2: "990010024",
  kasse: "990020015",
  kostentraeger: "990020026",
  davMitEntschluesselung: "990030017",
  davWeiterleitung: "990030028",
  belegannahme: "990040019",
  abrechnungsstelle: "990050012",
} as const;

export function testPraxis(ueber: Partial<Praxis> = {}): Praxis {
  return {
    ik: TEST_IK.praxis,
    name: "Podologie Testpraxis",
    ansprechpartner: "Frau Test",
    telefon: "030 0000000",
    email: "abrechnung@example.org",
    anschrift: { strasse: "Teststraße 1", plz: "10115", ort: "Berlin" },
    abrechnungscode: "71",
    tarifkennzeichen: "50000",
    ...ueber,
  };
}

export function testFall1(): Abrechnungsfall {
  return {
    belegnummer: "1",
    beleginformation: "1",
    versicherter: {
      versichertennummer: "X000000001",
      versichertenstatus: "1000000",
      nachname: "Mustermann",
      vorname: "Erika",
      geburtsdatum: "1950-04-12",
    },
    verordnung: {
      betriebsstaettennummer: "999000001",
      lanr: "999000101",
      verordnungsdatum: "2026-10-01",
      diagnosegruppe: "DF",
      verordnungsart: "03",
      therapieberichtAngefordert: false,
      hausbesuch: true,
      leitsymptomatik: { art: "heilmittelrichtlinie", a: true, b: false, c: false, patientenindividuell: false },
      dringlicherBehandlungsbedarf: false,
      heilmittelbereich: "2",
      therapiefrequenz: 0,
      diagnosen: [{ icd10: "E11.74" }],
    },
    zuzahlungskennzeichen: "3",
    leistungen: [
      { positionsnummer: "99901", anzahl: 1, einzelpreisCent: 3555, datum: "2026-10-05", zuzahlungsfaehig: true },
      { positionsnummer: "99902", anzahl: 1, einzelpreisCent: 1200, datum: "2026-10-05", text: "Hausbesuch", zuzahlungsfaehig: true },
      { positionsnummer: "99903", anzahl: 1, einzelpreisCent: 450, datum: "2026-10-05", gefahreneKilometer: 12, zuzahlungsfaehig: true },
      { positionsnummer: "99901", anzahl: 1, einzelpreisCent: 3555, datum: "2026-10-19", zuzahlungsfaehig: true },
    ],
  };
}

export function testFall2(): Abrechnungsfall {
  return {
    belegnummer: "2",
    beleginformation: "1",
    versicherter: {
      versichertennummer: "X000000002",
      versichertenstatus: "3",
      // Beispiel aus TA1 5.1 (S. 13): Steuerzeichen im Namen
      nachname: "D'Angelo",
      vorname: "Luigi",
      geburtsdatum: "1971-00-00",
    },
    verordnung: {
      verordnungsdatum: "2026-09-28",
      diagnosegruppe: "NF",
      verordnungsart: "03",
      therapieberichtAngefordert: true,
      hausbesuch: false,
      leitsymptomatik: { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: true },
      leitsymptomatikText: "Nagelrand, schmerzhaft: links+rechts",
      dringlicherBehandlungsbedarf: true,
      therapiefrequenz: 0,
      diagnosen: [{ text: "Diabetisches Fußsyndrom, Test?" }],
      genehmigung: { kennzeichen: "GEN-TEST-1", datum: "2026-09-30", art: "B2" },
    },
    zuzahlungskennzeichen: "1",
    leistungen: [{ positionsnummer: "99901", anzahl: 2, einzelpreisCent: 3555, datum: "2026-10-07", zuzahlungsfaehig: true }],
  };
}

export function testDatei(ueber: Partial<Nutzdatendatei> = {}): Nutzdatendatei {
  return {
    taVersion: "21",
    absender: { ik: TEST_IK.praxis, art: "S" },
    empfaengerIk: TEST_IK.davMitEntschluesselung,
    erstellt: { datum: "2026-11-02", uhrzeit: "09:30" },
    datenaustauschreferenz: 1,
    dateiart: "test",
    abrechnungsmonat: 10,
    rechnungsart: "1",
    zuzahlungProzent: 10,
    leistungserbringer: [
      {
        praxis: testPraxis(),
        kostentraeger: [
          {
            kostentraegerIk: TEST_IK.kostentraeger,
            rechnungen: [
              { kasseIk: TEST_IK.kasse, kasseName: "Testkasse Nord", rechnungsnummer: "2026-10/0001", rechnungsdatum: "2026-11-02", verarbeitungskennzeichen: "01", faelle: [testFall1()] },
              { kasseIk: TEST_IK.kostentraeger, kasseName: "Testkasse Zentrale", rechnungsnummer: "2026-10/0002", rechnungsdatum: "2026-11-02", verarbeitungskennzeichen: "01", faelle: [testFall2()] },
            ],
          },
        ],
      },
    ],
    zeilenumbruch: true,
    ...ueber,
  };
}
