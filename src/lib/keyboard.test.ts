import { afterEach, describe, expect, it, vi } from "vitest";
import { opensKeyboard, subscribeFocusSettled } from "./keyboard";

const input = (type: string, readOnly = false) => ({ tagName: "INPUT", type, readOnly, isContentEditable: false });

describe("opensKeyboard", () => {
  it("Text-, Zahl-, Such-, E-Mail-, Telefonfelder und Textbereiche öffnen die Tastatur", () => {
    for (const t of ["text", "number", "search", "email", "tel", "url", "password"]) expect(opensKeyboard(input(t)), t).toBe(true);
    expect(opensKeyboard({ tagName: "TEXTAREA", readOnly: false })).toBe(true);
    expect(opensKeyboard({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("Datum/Uhrzeit/Monat/Woche, Select, Schalter und Knöpfe nicht", () => {
    for (const t of ["date", "time", "datetime-local", "month", "week", "checkbox", "radio", "range", "color", "file", "submit", "button"]) expect(opensKeyboard(input(t)), t).toBe(false);
    expect(opensKeyboard({ tagName: "SELECT" })).toBe(false);
    expect(opensKeyboard({ tagName: "BUTTON", type: "submit" })).toBe(false);
    expect(opensKeyboard({ tagName: "BODY" })).toBe(false);
    expect(opensKeyboard(null)).toBe(false);
  });
  it("schreibgeschützte Felder öffnen keine Tastatur", () => {
    expect(opensKeyboard(input("text", true))).toBe(false);
    expect(opensKeyboard({ tagName: "TEXTAREA", readOnly: true })).toBe(false);
  });
});

describe("subscribeFocusSettled", () => {
  afterEach(() => vi.useRealTimers());

  it("Feldwechsel (focusout → focusin) meldet erst danach und nur einmal – kein Zwischenstand ohne Fokus", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const cb = vi.fn();
    const off = subscribeFocusSettled(target, cb);
    target.dispatchEvent(new Event("focusout"));
    target.dispatchEvent(new Event("focusin"));
    expect(cb).not.toHaveBeenCalled(); // sofortiges Melden würde den Moment ohne Fokus sichtbar machen (Aufblitzen)
    vi.runAllTimers();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });
  it("Abmelden stoppt ausstehende Meldungen und weitere Ereignisse", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const cb = vi.fn();
    const off = subscribeFocusSettled(target, cb);
    target.dispatchEvent(new Event("focusout"));
    off();
    vi.runAllTimers();
    target.dispatchEvent(new Event("focusin"));
    vi.runAllTimers();
    expect(cb).not.toHaveBeenCalled();
  });
});
