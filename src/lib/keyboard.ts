/**
 * Bildschirmtastatur erkennen (untere Leiste ausblenden, src/components/app-nav.tsx) – ohne React/DOM-Abhängigkeit,
 * damit die Regeln per Unit-Test prüfbar sind (src/lib/keyboard.test.ts).
 */

/** Was vom fokussierten Element gebraucht wird (HTMLElement erfüllt das) */
export type FocusedLike = { tagName: string; type?: string; readOnly?: boolean; isContentEditable?: boolean } | null | undefined;

/** Eingabetypen ohne Schreibtastatur: Knöpfe/Schalter, Datei – und Datum/Uhrzeit (öffnen eine Auswahl, iOS: Rad) */
export const NO_KEYBOARD_INPUTS: readonly string[] = [
  "checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "hidden", "image",
  "date", "time", "datetime-local", "month", "week",
];

/** true, wenn das fokussierte Element auf Touch-Geräten die Schreibtastatur öffnet (Select: Auswahlmenü → false) */
export function opensKeyboard(el: FocusedLike): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return !el.readOnly;
  if (tag === "INPUT") return !el.readOnly && !NO_KEYBOARD_INPUTS.includes((el.type ?? "text").toLowerCase());
  return false;
}

/**
 * Fokus-Wechsel melden – erst nach dem Ereignis (setTimeout 0, mehrere Ereignisse zusammengefasst): beim Wechsel von
 * Feld zu Feld liegt zwischen focusout und focusin kurz kein Feld im Fokus; sofort gelesen, würde die Leiste aufblitzen.
 * `target`: im Browser `document`.
 */
export function subscribeFocusSettled(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, cb: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(cb, 0);
  };
  target.addEventListener("focusin", later);
  target.addEventListener("focusout", later);
  return () => {
    clearTimeout(timer);
    target.removeEventListener("focusin", later);
    target.removeEventListener("focusout", later);
  };
}
