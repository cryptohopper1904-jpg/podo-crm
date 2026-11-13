import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, PRODUCT_URL } from "./constants";
import { cleanValue, composeMail, placeholderValues, renderText, templateUsesPromo, unknownPlaceholders, validateTemplate } from "./template";

const values = placeholderValues({ name: "Podologie Am Markt", contactPerson: "Frau Muster", city: "Musterstadt" }, "Max Betreiber");

describe("Vorlagen: Platzhalter", () => {
  it("ersetzt alle Platzhalter", () => {
    expect(renderText("{{anrede}}, {{praxis}} in {{ort}} – {{absender}} ({{ansprechpartner}})", values)).toBe(
      "Guten Tag Frau Muster, Podologie Am Markt in Musterstadt – Max Betreiber (Frau Muster)",
    );
  });

  it("ohne Ansprechpartner:in: neutrale Anrede, kein Leerzeichen vor Satzzeichen", () => {
    const v = placeholderValues({ name: "Praxis X", contactPerson: null, city: null }, "Max");
    expect(renderText("{{anrede}},", v)).toBe("Guten Tag,");
    expect(renderText("Guten Tag {{ansprechpartner}},", v)).toBe("Guten Tag,");
    expect(renderText("in {{ort}}.", v)).toBe("in Ihrer Region.");
  });

  it("Werte werden nicht erneut ersetzt (keine Platzhalter-Injektion) und sind einzeilig", () => {
    const v = placeholderValues({ name: "{{absender}}\r\nBcc: evil@x.de", contactPerson: "Herr\nX", city: "Ort" }, "Max");
    const out = renderText("{{praxis}} / {{ansprechpartner}}", v);
    expect(out).toBe("{{absender}} Bcc: evil@x.de / Herr X");
    expect(cleanValue("a\u0000b c   d")).toBe("a b c d");
  });

  it("Aktionscode: {{code}}/{{link}} werden ersetzt; Vorlage mit Code wird erkannt", () => {
    const v = placeholderValues({ name: "P", city: "O" }, "Max", { code: "PODO-AB12", link: "https://podo.example/aktion/PODO-AB12" });
    expect(renderText("Code {{code}} unter {{ link }}.", v)).toBe("Code PODO-AB12 unter https://podo.example/aktion/PODO-AB12.");
    expect(validateTemplate({ subject: "3 Monate gratis: {{CODE}}", body: "{{link}}" })).toBeNull();
    expect(templateUsesPromo({ subject: "x", body: "Ihr Link: {{ link }}" })).toBe(true);
    expect(templateUsesPromo({ subject: "{{Code}}", body: "x" })).toBe(true);
    expect(templateUsesPromo(DEFAULT_TEMPLATES[0])).toBe(false);
    const m = composeMail({ template: { subject: "Code {{code}}", body: "{{link}}" }, lead: { name: "P" }, senderName: "Max", impressum: "Impressum", unsubscribeUrl: "https://u", privacyUrl: "https://p/datenschutz#vertrieb", promo: { code: "PODO-AB12", link: "https://podo.example/aktion/PODO-AB12\nBcc: x" } });
    expect(m.subject).toBe("Code PODO-AB12");
    expect(m.text.split("\n")[0]).toBe("https://podo.example/aktion/PODO-AB12 Bcc: x");
  });

  it("unbekannte Platzhalter bleiben sichtbar und werden beim Speichern abgelehnt", () => {
    expect(renderText("Hallo {{vorname}}", values)).toBe("Hallo {{vorname}}");
    expect(unknownPlaceholders("{{praxis}} {{vorname}} {{ ORT }}")).toEqual(["vorname"]);
    expect(validateTemplate({ subject: "Hi {{x}}", body: "Text" })).toMatch(/Unbekannte Platzhalter/);
    expect(validateTemplate({ subject: "Zeile\nzwei", body: "Text" })).toMatch(/Zeilenumbruch/);
    expect(validateTemplate({ subject: "", body: "Text" })).toMatch(/Betreff/);
    expect(validateTemplate({ subject: "S", body: "  " })).toMatch(/Text/);
  });

  it("Standardvorlagen sind gültig, Sie-Form, Mail 1 mit Link und Demo-Angebot", () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(validateTemplate(t)).toBeNull();
      expect(t.body).not.toMatch(/\b(du|dich|dir|dein)\b/i);
    }
    expect(DEFAULT_TEMPLATES[0].body).toContain(PRODUCT_URL);
    expect(DEFAULT_TEMPLATES[0].body).toMatch(/30 Minuten/);
    expect(DEFAULT_TEMPLATES[1].body).toMatch(/Doctolib/);
    expect(DEFAULT_TEMPLATES[2].body).toMatch(/letzte Nachricht/);
  });
});

describe("composeMail", () => {
  const m = composeMail({
    template: { subject: "Hallo {{praxis}}\r\nBcc: x@y.de", body: "{{anrede}},\r\n\r\nText." },
    lead: { name: "Praxis X", contactPerson: null, city: "Ort" },
    senderName: "Max",
    impressum: "Muster GmbH\nMusterstr. 1, 12345 Musterstadt\nkontakt@podo.example",
    unsubscribeUrl: "https://podo.example/abmelden/abc.def",
    privacyUrl: "https://podo.example/datenschutz#vertrieb",
    unsubscribeMailto: "max@podo.example",
  });

  it("Betreff einzeilig, Text mit Impressum und Abmeldelink", () => {
    expect(m.subject).toBe("Hallo Praxis X Bcc: x@y.de");
    expect(m.text.startsWith("Guten Tag,\n\nText.\n\n-- \nMuster GmbH")).toBe(true);
    expect(m.text).toContain("https://podo.example/abmelden/abc.def");
    expect(m.text).toContain("Widerspruchsrecht nach Art. 21 DSGVO:\nhttps://podo.example/datenschutz#vertrieb");
    expect(m.text).toMatch(/abmelden/i);
    expect(m.text).not.toContain("\r");
  });

  it("List-Unsubscribe (Link + mailto) und One-Click-Kopfzeile", () => {
    expect(m.headers["List-Unsubscribe"]).toBe("<https://podo.example/abmelden/abc.def>, <mailto:max@podo.example?subject=Abmelden>");
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
