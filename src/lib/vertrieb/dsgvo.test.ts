import { describe, expect, it } from "vitest";
import {
  addMonthsUtc,
  anyConsentValid,
  art14Deadline,
  art14Overdue,
  art14Text,
  ART14_DRAFT_MARK,
  ART14_OPTIONAL_PLACEHOLDER,
  checkRetrievedDate,
  deleteAfterFor,
  deleteMonthsOf,
  emailConsentValid,
  fillPlaceholders,
  isConsentKind,
  ART14_MAIL_PLACEHOLDER,
  isExistingCustomerForPhone,
  isExistingCustomerForRetention,
  minDeleteMonths,
  NO_CONSENT_CONTACT_HINT,
  openPlaceholders,
  originLabel,
  phoneVisible,
} from "./dsgvo";

describe("Löschfrist", () => {
  it("Erhebung + n Monate in UTC, Monatsende gekappt", () => {
    expect(addMonthsUtc(new Date("2026-08-31T10:00:00Z"), 6).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2027-08-31T10:00:00Z"), 6).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(deleteAfterFor(new Date("2026-11-15T10:00:00Z"), 12).toISOString()).toBe("2027-11-15T10:00:00.000Z");
  });

  it("nur 6 bis 12 ganze Monate", () => {
    const c = new Date("2026-11-15T10:00:00Z");
    expect(() => deleteAfterFor(c, 5)).toThrow(/Löschfrist/);
    expect(() => deleteAfterFor(c, 13)).toThrow(/Löschfrist/);
    expect(() => deleteAfterFor(c, 24)).toThrow(/Löschfrist/);
    expect(() => deleteAfterFor(c, 8.5)).toThrow(/Löschfrist/);
    expect(deleteMonthsOf(c, deleteAfterFor(c, 9))).toBe(9);
    expect(deleteMonthsOf(c, new Date("2028-11-15T10:00:00Z"))).toBeNull();
  });

  it("beim Bearbeiten nur Fristen, deren Löschung mindestens 7 Tage in der Zukunft liegt", () => {
    const c = new Date("2026-01-10T10:00:00Z");
    expect(minDeleteMonths(c, new Date("2026-03-01T10:00:00Z"))).toBe(6);
    expect(minDeleteMonths(c, new Date("2026-07-05T10:00:00Z"))).toBe(7); // 6 Monate = 10.07. < 12.07.
    expect(minDeleteMonths(c, new Date("2027-01-05T10:00:00Z"))).toBeNull();
  });
});

describe("Herkunft und Erstbrief", () => {
  const now = new Date("2026-11-19T23:30:00Z"); // in Berlin schon der 20.11.
  it("Abrufdatum gültig, nicht in der Zukunft (deutsche Zeit)", () => {
    expect(checkRetrievedDate("2026-11-20", now)).toEqual({ ok: true, date: "2026-11-20" });
    expect(checkRetrievedDate("2026-11-21", now)).toMatchObject({ ok: false, error: expect.stringMatching(/Zukunft/) });
    expect(checkRetrievedDate("2026-02-30", now)).toMatchObject({ ok: false, error: expect.stringMatching(/ungültig/) });
    expect(checkRetrievedDate("", now)).toMatchObject({ ok: false, error: expect.stringMatching(/Abrufdatum/) });
    expect(checkRetrievedDate("1999-12-31", now)).toMatchObject({ ok: false });
  });

  it("Anzeige mit lesbarer Quelle und Hinweis bei fehlenden Angaben", () => {
    expect(originLabel("osm", "2026-11-03")).toBe("OpenStreetMap · abgerufen 03.11.2026");
    expect(originLabel("Messe Test", null)).toBe("Messe Test · Abrufdatum fehlt");
    expect(originLabel(null, null)).toBe("Quelle fehlt · Abrufdatum fehlt");
  });

  it("Erstbrief bis Abrufdatum + 1 Monat; überfällig nur ohne vermerkten Versand", () => {
    expect(art14Deadline("2026-10-31")).toBe("2026-11-30");
    expect(art14Deadline("2026-01-15")).toBe("2026-02-15");
    expect(art14Deadline(null)).toBeNull();
    expect(art14Overdue({ sourceRetrievedAt: "2026-10-01", art14NoticeAt: null }, "2026-11-19")).toBe(true);
    expect(art14Overdue({ sourceRetrievedAt: "2026-10-01", art14NoticeAt: "2026-10-20" }, "2026-11-19")).toBe(false);
    expect(art14Overdue({ sourceRetrievedAt: "2026-11-01", art14NoticeAt: null }, "2026-11-19")).toBe(false);
    expect(art14Overdue({ sourceRetrievedAt: null, art14NoticeAt: null }, "2026-11-19")).toBe(false);
  });
});

describe("Einwilligung je Kanal und Telefonnummer", () => {
  const none = { consentEmailAt: null, consentPhoneAt: null };
  it("gültig nur erteilt und nicht widerrufen", () => {
    expect(emailConsentValid({ consentEmailAt: new Date(), consentEmailRevokedAt: null })).toBe(true);
    expect(emailConsentValid({ consentEmailAt: new Date(), consentEmailRevokedAt: new Date() })).toBe(false);
    expect(anyConsentValid({ ...none, consentPhoneAt: new Date() })).toBe(true);
    expect(anyConsentValid(none)).toBe(false);
  });

  it("Telefonnummer nur mit Telefon-Einwilligung oder bei Bestandskunden (streng: Domain-Treffer nur bei bezahltem Abo)", () => {
    expect(phoneVisible({ ...none, status: "neu" })).toBe(false);
    expect(phoneVisible({ ...none, consentEmailAt: new Date(), status: "neu" })).toBe(false); // E-Mail-Einwilligung reicht nicht
    expect(phoneVisible({ ...none, consentPhoneAt: new Date(), status: "neu" })).toBe(true);
    expect(phoneVisible({ ...none, consentPhoneAt: new Date(), consentPhoneRevokedAt: new Date(), status: "neu" })).toBe(false);
    expect(phoneVisible({ ...none, status: "kunde" })).toBe(true);
    expect(phoneVisible({ ...none, status: "neu", org: { via: "email", converted: false } })).toBe(true);
    expect(phoneVisible({ ...none, status: "neu", org: { via: "code", converted: false } })).toBe(true);
    expect(phoneVisible({ ...none, status: "neu", org: { via: "domain", converted: false } })).toBe(false);
    expect(phoneVisible({ ...none, status: "neu", org: { via: "domain", converted: true } })).toBe(true);
    expect(isExistingCustomerForPhone({ status: "neu", org: null })).toBe(false);
  });

  it("Löschlauf (vorsichtig): jede zugeordnete Praxis schont, auch ein unsicherer Domain-Treffer", () => {
    expect(isExistingCustomerForRetention({ status: "neu", stage: "test" })).toBe(true);
    expect(isExistingCustomerForRetention({ status: "neu", stage: "kunde" })).toBe(true);
    expect(isExistingCustomerForRetention({ status: "kunde", stage: "neu" })).toBe(true);
    expect(isExistingCustomerForRetention({ status: "interessiert", stage: "geantwortet" })).toBe(false);
  });

  it("Erteilungsweg nur aus der Liste; Hinweistext wörtlich", () => {
    expect(isConsentKind("persoenlich")).toBe(true);
    expect(isConsentKind("fax")).toBe(false);
    expect(NO_CONSENT_CONTACT_HINT).toBe(
      "Werbung per E-Mail nur mit vorheriger ausdrücklicher Einwilligung in E-Mails (§ 7 Abs. 2 Nr. 2 UWG). Werbeanrufe nur mit vorheriger ausdrücklicher Einwilligung in Anrufe (§ 7 Abs. 2 Nr. 1 UWG). Auf eine „mutmaßliche Einwilligung“ stützen wir uns bewusst nicht. Kaltanrufe sind nicht erlaubt. Die Einwilligung gilt nur für den Kanal, für den sie erteilt wurde.",
    );
  });
});

describe("Datenschutzhinweis nach Art. 14 DSGVO", () => {
  it("Widerspruchsrecht als Kasten ganz oben, Pflichtinhalte, kein Entwurfsvermerk im Brieftext", () => {
    const t = art14Text();
    expect(ART14_DRAFT_MARK).toBe("ENTWURF – vor Verwendung rechtlich prüfen lassen");
    expect(t).not.toContain("ENTWURF");
    const lines = t.split("\n");
    expect(lines[0]).toMatch(/^=+$/);
    expect(lines[1]).toMatch(/^Ihr Widerspruchsrecht \(Art\. 21 Abs\. 2 DSGVO\): Sie können der Verwendung Ihrer Daten für Werbung jederzeit/);
    expect(lines[2]).toBe(lines[0]);
    for (const part of [
      "Eine Pflicht zur Benennung eines Datenschutzbeauftragten besteht nicht. Ihre Anfragen richten Sie an {{Datenschutzkontakt}}.",
      "bei Einzelpraxen damit auch der Name der Inhaberin oder des Inhabers",
      "eine Antwort von Ihnen zuordnen zu können und doppelte Anschreiben zu vermeiden",
      "soweit dort veröffentlicht: Name einer Ansprechperson, geschäftliche E-Mail-Adresse, Telefonnummer und Website; die Entfernung Ihrer Praxis zu unserem Standort;",
      "sowie Vermerke über eine Einwilligung und deren Widerruf.",
      "Art. 6 Abs. 1 lit. f DSGVO",
      "Wir verkaufen oder vermieten Ihre Daten nicht.",
      "Hosting in Deutschland {{E-Mail-Dienstleister}} {{ggf. Druck- und Versanddienstleister}}.",
      "Wir löschen Ihre Daten automatisch am {{Löschdatum}}. Unsere Schreiben und Ihre Antworten verlängern diese Frist nicht.",
      "Widerrufen Sie Ihre Einwilligung, löschen wir am {{Löschdatum}} oder, wenn dieser Tag schon vorbei ist, umgehend.",
      "Werden Sie Kundin oder Kunde, gelten die Fristen unseres Vertrags und die gesetzlichen Aufbewahrungsfristen.",
      "Website-Adresse sowie Praxisname und Postleitzahl nur noch als nicht umkehrbaren Prüfwert (nicht im Klartext)",
      "(Art. 7 Abs. 3 DSGVO)",
      "{{Abrufdatum}}",
    ]) {
      expect(t).toContain(part);
    }
    expect(t).not.toContain("Art. 20");
    expect(t).toContain("bis 24 Monate nach Ihrer letzten Antwort oder Einwilligung");
    expect(t).not.toContain("verschlüsselten");
  });

  it("setzt Quelle, Abrufdatum und Löschdatum ein; Platzhalter füllen, optionaler Dienstleister entfällt oder wird ergänzt", () => {
    const t = art14Text({ quelle: "OpenStreetMap", abrufdatum: "03.11.2026", loeschdatum: "03.11.2027" });
    expect(t).toContain("Quellen: OpenStreetMap, abgerufen am 03.11.2026.");
    expect(t).toContain("automatisch am 03.11.2027.");
    expect(openPlaceholders(t)).toEqual(["Firma", "E-Mail", "Datenschutzkontakt", ART14_MAIL_PLACEHOLDER, ART14_OPTIONAL_PLACEHOLDER, "Aufsichtsbehörde"]);
    const base = { Firma: "Muster GmbH", "E-Mail": "datenschutz@muster.example", Datenschutzkontakt: "datenschutz@muster.example", Aufsichtsbehörde: "LDA Brandenburg" };
    expect(openPlaceholders(fillPlaceholders(t, base))).toEqual([ART14_MAIL_PLACEHOLDER, ART14_OPTIONAL_PLACEHOLDER]);
    expect(openPlaceholders(fillPlaceholders(t, { ...base, Firma: "  " }))).toContain("Firma");
    const ohne = fillPlaceholders(t, { ...base, [ART14_MAIL_PLACEHOLDER]: "", [ART14_OPTIONAL_PLACEHOLDER]: "" });
    expect(openPlaceholders(ohne)).toEqual([]);
    expect(ohne).toContain("Hosting in Deutschland. Eine Übermittlung");
    expect(fillPlaceholders(t, { ...base, [ART14_MAIL_PLACEHOLDER]: "Mailversand GmbH (Deutschland)", [ART14_OPTIONAL_PLACEHOLDER]: "Druckerei Beispiel GmbH" })).toContain(
      "Hosting in Deutschland; E-Mail-Dienstleister Mailversand GmbH (Deutschland); Druckerei Beispiel GmbH. Eine",
    );
    expect(ohne).toContain("Eine formlose Nachricht an Muster GmbH genügt");
  });
});
