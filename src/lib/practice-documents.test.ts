import { describe, expect, it } from "vitest";
import { invoiceBookingLink, readDocumentSettings, shortUrl } from "./practice-documents";

const ctx = { slug: "podologie-kiehne", publicUrl: "https://app.podohero.de/" };
const withBooking = (booking: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ documents: { booking }, ...extra });

describe("Belege-Einstellungen", () => {
  it("liefert sichere Standardwerte", () => {
    expect(readDocumentSettings({})).toEqual({ dueDays: 14, qualification: null, whatsapp: false, booking: { channel: "none", url: null, label: null } });
    expect(readDocumentSettings({ documents: { booking: { channel: "evil" }, whatsapp: "yes" } }).booking.channel).toBe("none");
  });
  it("verwirft Nicht-http(s)-Links", () => {
    expect(readDocumentSettings(withBooking({ channel: "custom", url: "javascript:alert(1)" })).booking.url).toBeNull();
  });
});

describe("Buchungshinweis auf Rechnungen", () => {
  it("PodoHero-Online-Buchung: eigene Buchungsseite", () => {
    expect(invoiceBookingLink(withBooking({ channel: "podohero" }), ctx)).toEqual({
      label: "Nächsten Termin online buchen:",
      url: "https://app.podohero.de/buchen/podologie-kiehne",
      display: "app.podohero.de/buchen/podologie-kiehne",
    });
  });
  it("PodoHero: kein Hinweis ohne PUBLIC_URL oder bei abgeschalteter Online-Buchung", () => {
    expect(invoiceBookingLink(withBooking({ channel: "podohero" }), { slug: "x-y", publicUrl: null })).toBeNull();
    expect(invoiceBookingLink(withBooking({ channel: "podohero" }, { onlineBooking: { enabled: false } }), ctx)).toBeNull();
  });
  it("Doctolib und Andere: hinterlegter Link mit (eigener) Beschriftung", () => {
    expect(invoiceBookingLink(withBooking({ channel: "doctolib", url: "https://www.doctolib.de/podologe/hohen-neuendorf/kiehne" }), ctx)).toMatchObject({
      url: "https://www.doctolib.de/podologe/hohen-neuendorf/kiehne",
      display: "www.doctolib.de/podologe/hohen-neuendorf/kiehne",
      label: "Nächsten Termin online buchen (Doctolib):",
    });
    expect(invoiceBookingLink(withBooking({ channel: "custom", url: "https://termine.example.org/", label: "Termin bei uns:" }), ctx)).toEqual({
      label: "Termin bei uns:",
      url: "https://termine.example.org/",
      display: "termine.example.org",
    });
  });
  it("kein Hinweis bei „keiner“ oder fehlendem Link", () => {
    expect(invoiceBookingLink(withBooking({ channel: "none", url: "https://x.example" }), ctx)).toBeNull();
    expect(invoiceBookingLink(withBooking({ channel: "doctolib" }), ctx)).toBeNull();
    expect(invoiceBookingLink({}, ctx)).toBeNull();
  });
  it("Kurz-URL ohne Schema und abschließenden Schrägstrich", () => {
    expect(shortUrl("https://www.podologie-kiehne.de/")).toBe("www.podologie-kiehne.de");
  });
});

describe("Standard-Zahlungsziel", () => {
  it("liest documents.dueDays (0 = sofort), sonst 14 Tage", () => {
    expect(readDocumentSettings({ documents: { dueDays: 0 } }).dueDays).toBe(0);
    expect(readDocumentSettings({ documents: { dueDays: 30 } }).dueDays).toBe(30);
    expect(readDocumentSettings({}).dueDays).toBe(14);
    expect(readDocumentSettings({ documents: { dueDays: -1 } }).dueDays).toBe(14);
    expect(readDocumentSettings({ documents: { dueDays: 500 } }).dueDays).toBe(14);
    expect(readDocumentSettings({ documents: { dueDays: "7" } }).dueDays).toBe(14);
  });
});
