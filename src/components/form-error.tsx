"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef } from "react";

/** Meldung in die Bildschirmmitte holen und fokussieren (Fokus ohne zweites Springen). */
export function revealMessage(el: HTMLElement) {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * Wann soll eine Meldung angesprungen werden? Bei neuer oder geänderter Meldung – und bei derselben Meldung erneut,
 * wenn sich `revealKey` (z. B. das Ergebnis-Objekt von useActionState) geändert hat, also erneut abgesendet wurde.
 */
export function shouldReveal(prev: { message?: string | null; key?: unknown }, next: { message?: string | null; key?: unknown }): boolean {
  if (!next.message) return false;
  if (next.message !== prev.message) return true;
  return next.key !== undefined && next.key !== prev.key;
}

/**
 * Fehlermeldung eines Formulars. Steht oben im Formular – auf dem Handy ist man beim Absenden aber unten am Knopf.
 * Deshalb wird eine neue Meldung in die Bildschirmmitte gescrollt und fokussiert (role="alert" liest sie vor) – nicht
 * eine Meldung, die schon beim ersten Rendern da ist (Seite lädt nicht „springend“, Fokus bleibt am Seitenanfang).
 * `revealKey`: Ergebnis-Objekt der Server Action übergeben (`revealKey={state}`), dann wird auch eine unveränderte
 * Meldung nach erneutem Absenden wieder angesprungen. Das Element bleibt (versteckt) im DOM, damit die Live-Region
 * schon vor der ersten Meldung besteht.
 */
export function FormError({ message, revealKey, id }: { message?: string | null; revealKey?: unknown; id?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // Mit der Anfangsmeldung starten: eine schon beim Laden vorhandene Meldung (z. B. ?fehler=…) wird nicht angesprungen
  const prev = useRef<{ message?: string | null; key?: unknown }>({ message, key: revealKey });
  useEffect(() => {
    const next = { message, key: revealKey };
    if (ref.current && shouldReveal(prev.current, next)) revealMessage(ref.current);
    prev.current = next;
  }, [message, revealKey]);
  return (
    <p
      ref={ref}
      id={id}
      role="alert"
      tabIndex={-1}
      hidden={!message}
      className="scroll-m-24 rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text"
    >
      {message ? (
        <span className="flex items-start gap-2">
          <CircleAlert size={18} aria-hidden className="mt-px shrink-0" />
          <span className="min-w-0">{message}</span>
        </span>
      ) : null}
    </p>
  );
}

/**
 * Erfolgsmeldung eines Formulars (role="status"). Erscheint sie nach dem Absenden außerhalb des Sichtfelds, wird sie
 * sichtbar gescrollt (ohne Fokus – der bleibt am Formular). `focus`: Meldung fokussieren – nötig, wenn der Absende-Knopf
 * mit der Meldung verschwindet (sonst fiele der Fokus auf <body>). Wie FormError: nicht für eine Meldung beim Laden.
 */
export function FormSuccess({ message, focus }: { message?: string | null; focus?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const last = useRef<string | null | undefined>(message);
  useEffect(() => {
    const el = ref.current;
    if (el && message && message !== last.current) {
      if (focus) revealMessage(el);
      else {
        const r = el.getBoundingClientRect();
        if (r.top < 64 || r.bottom > innerHeight - 80) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    }
    last.current = message;
  }, [message, focus]);
  return (
    <p ref={ref} role="status" tabIndex={focus ? -1 : undefined} hidden={!message} className="scroll-m-24 rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">
      {message ? (
        <span className="flex items-start gap-2">
          <CircleCheck size={18} aria-hidden className="mt-px shrink-0" />
          <span className="min-w-0">{message}</span>
        </span>
      ) : null}
    </p>
  );
}
