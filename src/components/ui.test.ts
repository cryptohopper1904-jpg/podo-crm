import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorContext } from "./error-screen";
import { shouldReveal } from "./form-error";
import { addToast, MAX_TOASTS, type ToastItem } from "./toaster";
import { Checkbox, Empty, Field, FormActions, Input, numberInputMode, SegmentedControl, Table } from "./ui";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("Input mit Einheit (F1)", () => {
  it("Zahlenfeld: Einheit neben der Eingabe, ohne Browser-Pfeile, Ziffernblock", () => {
    const out = html(h(Input, { type: "number", name: "intervalWeeks", suffix: "Wochen", min: 1, max: 12, defaultValue: 1 }));
    // Einheit ist ein eigenes Element hinter dem <input> (kein absolut darübergelegtes Overlay mehr)
    expect(out).toMatch(/<input[^>]*name="intervalWeeks"[^>]*>.*<span aria-hidden="true"[^>]*>Wochen<\/span>/);
    expect(out).not.toContain("absolute");
    expect(out).toContain("[&amp;::-webkit-inner-spin-button]:appearance-none");
    expect(out).toContain('inputMode="numeric"');
    expect(out).toContain(" in Wochen");
  });
  it("Textfeld mit € behält seine Tastatur, keine Pfeil-Klassen", () => {
    const out = html(h(Input, { name: "materialCost", suffix: "€", inputMode: "decimal" }));
    expect(out).toContain('inputMode="decimal"');
    expect(out).not.toContain("inner-spin-button");
    expect(out).toContain(" in Euro");
  });
  it("Stepper: −/+-Knöpfe mit Namen", () => {
    const out = html(h(Input, { type: "number", name: "n", suffix: "Wochen", stepper: true }));
    expect(out).toContain('aria-label="Weniger Wochen"');
    expect(out).toContain('aria-label="Mehr Wochen"');
    expect(out.match(/<button/g)).toHaveLength(2);
  });
  it("Tastatur je nach Schrittweite", () => {
    expect(numberInputMode(undefined)).toBe("numeric");
    expect(numberInputMode(1)).toBe("numeric");
    expect(numberInputMode("0.01")).toBe("decimal");
    expect(numberInputMode("any")).toBe("decimal");
    expect(numberInputMode(1, "text")).toBe("text");
  });
});

describe("Datumsfelder (F9)", () => {
  it("leeres Datum ist als leer markiert und zeigt einen eigenen Platzhalter", () => {
    const out = html(h(Input, { type: "date", name: "endsOn", placeholder: "ohne Ende" }));
    expect(out).toContain("data-empty");
    expect(out).toContain("ohne Ende");
  });
  it("gesetztes Datum nicht", () => {
    const out = html(h(Input, { type: "date", name: "startsOn", defaultValue: "2026-11-14" }));
    expect(out).not.toContain("data-empty");
    expect(out).not.toContain("Kein Datum");
  });
});

describe("Checkbox (F4)", () => {
  it("Kästchen schrumpft nicht und sitzt oben", () => {
    const out = html(h(Checkbox, { name: "x", label: "Antikoagulation / Blutverdünner (Marcumar, Xarelto …)" }));
    expect(out).toMatch(/<input type="checkbox" class="[^"]*shrink-0/);
    expect(out).toMatch(/<label class="[^"]*items-start/);
  });
});

describe("Feldfehler (F3)", () => {
  it("setzt aria-invalid und aria-describedby an der Eingabe", () => {
    const out = html(h(Field, { label: "Datum", id: "datum", error: "Bitte ein Datum wählen", children: h(Input, { name: "datum" }) }));
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="datum-fehler"');
    expect(out).toContain('id="datum-fehler"');
  });
  it("verknüpft den Hinweis auch ohne Fehler (aria-describedby), ohne aria-invalid", () => {
    const out = html(h(Field, { label: "Dauer", id: "dauer", hint: "0 = einmalig", children: h(Input, { name: "dauer" }) }));
    expect(out).toContain('aria-describedby="dauer-hinweis"');
    expect(out).toContain('id="dauer-hinweis"');
    expect(out).not.toContain('aria-invalid="');
    const both = html(h(Field, { label: "Dauer", id: "dauer", hint: "0 = einmalig", error: "Fehlt", children: h(Input, { name: "dauer" }) }));
    expect(both).toContain('aria-describedby="dauer-fehler dauer-hinweis"');
  });
  it("ohne id: eigene id, Hinweis außerhalb des <label> (nicht Teil des Namens), aber verknüpft", () => {
    const out = html(h(Field, { label: "Dauer", hint: "0 = einmalig", children: h(Input, { name: "dauer" }) }));
    const id = out.match(/<input[^>]* id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<label for="${id}"`);
    expect(out).toMatch(/<label[^>]*>Dauer<\/label>/);
    expect(out).toContain(`aria-describedby="${id}-hinweis"`);
    expect(out).toContain(`id="${id}-hinweis"`);
  });
  it("Einheit gehört zum Namen: „Dauer in Minuten“ steht im <label>, nicht verwaist neben der Eingabe", () => {
    const out = html(h(Field, { label: "Dauer", children: h(Input, { type: "number", name: "durationMin", suffix: "Min" }) }));
    expect(out).toMatch(/<label for="[^"]+"[^>]*>Dauer<span class="sr-only"> in Minuten<\/span><\/label>/);
    expect(out.match(/ in Minuten/g)).toHaveLength(1);
    // sichtbare Einheit bleibt im Feld
    expect(out).toMatch(/<span aria-hidden="true"[^>]*>Min<\/span>/);
  });
  it("Rückfall-Weg: Fehler setzt aria-invalid/aria-describedby am einzelnen Kind", () => {
    const out = html(h(Field, { label: "Preis", error: "Pflichtfeld", children: h("span", { className: "block w-36" }, h("input", { name: "p" })) }));
    const errId = out.match(/<span id="([^"]+-fehler)"/)?.[1];
    expect(errId).toBeTruthy();
    expect(out).toContain(`<span class="block w-36" aria-invalid="true" aria-describedby="${errId}">`);
  });
  it("eigene Komponenten als Kind: bleibt ein umschließendes <label>", () => {
    const out = html(h(Field, { label: "Preis", hint: "brutto", children: h("span", { className: "block w-36" }, h("input", { name: "p" })) }));
    expect(out).toMatch(/^<label class="podo-field/);
  });
  it("shouldReveal: Ausgangswerte = Anfangsmeldung → kein Anspringen (Verhalten im Browser: e2e/formular-meldungen.spec.ts)", () => {
    const k = {};
    expect(shouldReveal({ message: "Link abgelaufen", key: k }, { message: "Link abgelaufen", key: k })).toBe(false);
    expect(shouldReveal({ message: "Link abgelaufen" }, { message: "Link abgelaufen" })).toBe(false);
  });
  it("Fehlermeldung wird bei neuer Meldung oder erneutem Absenden angesprungen", () => {
    const a = {};
    const b = {};
    expect(shouldReveal({ message: null }, { message: "Fehlt" })).toBe(true);
    expect(shouldReveal({ message: "Fehlt", key: a }, { message: "Fehlt", key: a })).toBe(false);
    expect(shouldReveal({ message: "Fehlt", key: a }, { message: "Fehlt", key: b })).toBe(true);
    expect(shouldReveal({ message: "Fehlt" }, { message: null })).toBe(false);
  });
  it("Aktionsleiste zeigt die Kurzmeldung neben dem Knopf", () => {
    const out = html(h(FormActions, { error: "Bitte Patient wählen", children: h("button", null, "Speichern") }));
    expect(out).toContain("sticky");
    expect(out).toContain("Bitte Patient wählen");
    expect(out).toContain("bottom-[var(--podo-sticky-bottom)]");
  });
});

describe("Tabellen, leere Zustände, Umschalter (F10, F12–F14)", () => {
  it("Tabelle: Scrollbereich begrenzt, Kopf ohne Versalien und 13 px", () => {
    const out = html(h(Table, { label: "Rechnungen", children: h("thead", null, h("tr", null, h("th", null, "Datum"))) }));
    expect(out).toContain("max-w-full");
    expect(out).toContain("[&amp;_th]:text-[13px]");
    expect(out).not.toContain("uppercase");
  });
  it("Leerer Zustand mit nächstem Schritt", () => {
    const out = html(h(Empty, { title: "Keine Termine", action: h("a", { href: "/kalender/neu" }, "+ Termin") }));
    expect(out).toContain('href="/kalender/neu"');
  });
  it("SegmentedControl markiert den aktiven Eintrag", () => {
    const out = html(h(SegmentedControl, { label: "Ansicht", items: [{ href: "/a", label: "Tag", active: true }, { href: "/b", label: "Woche" }] }));
    expect(out).toContain('aria-label="Ansicht"');
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("Fehlerseiten (F6)", () => {
  it("unterscheidet Patient:innen-Seiten, öffentliche Seiten und Praxis-App", () => {
    expect(errorContext("/buchen/xyz")).toBe("patient");
    expect(errorContext("/p")).toBe("patient");
    expect(errorContext("/portal?t=1")).toBe("patient");
    expect(errorContext("/preise")).toBe("public");
    expect(errorContext("/")).toBe("public");
    expect(errorContext(null)).toBe("public");
    expect(errorContext("/kunden/123")).toBe("app");
    expect(errorContext("/pruefung")).toBe("app");
  });
});

describe("Meldungen (F7)", () => {
  it("höchstens drei gleichzeitig, älteste fällt weg", () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= 5; i++) list = addToast(list, { id: i, message: `M${i}`, tone: "success", duration: 5000 });
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
  });
});
