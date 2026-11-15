/**
 * Schutz der Vorschau des Übernahme-Assistenten: Klardaten in Hinweisen maskieren und Durchläufe je Person drosseln.
 * (AppSec-Hinweis: Warnungen dürfen keine E-Mail-Adressen, Geburtsdaten oder Telefonnummern im Klartext zeigen.)
 */
import { createRateLimiter } from "@/lib/rate-limit";

/** Vorschau + Import zusammen: höchstens 20 Durchläufe je Person und Praxis in 10 Minuten */
export const uebernahmeLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20, maxKeys: 2_000 });

const EMAIL = /[^\s@„“"'()<>,;]+@[^\s@„“"'()<>,;]*\.[^\s@„“"'()<>,;]*[^\s@„“"'()<>,;.]/g;
/** Telefonnummern: beginnt mit + oder 0, mindestens 7 Ziffern (Rechnungsnummern wie RE-2026-00001 bleiben) */
const PHONE = /(?:\+|\b0)\d[\d /-]{5,}\d/g;
const SENSITIVE = /geburt|e-?mail|telefon|handy|mobil|festnetz/i;

export function maskPii(message: string): string {
  let m = message.replace(EMAIL, "***@***").replace(PHONE, "***");
  if (SENSITIVE.test(m)) {
    // Rohwerte in Anführungszeichen bzw. Klammern (z. B. „31.02.1950“, (0151 …)) – nicht das Pseudonym „(Jg. 1950)“
    m = m.replace(/„[^“]*“/g, "„***“").replace(/\((?!Jg\. \d{4}\))[^()]*\d[^()]*\)/g, "(***)");
  }
  return m;
}
