/**
 * Kürzel archivierter Leistungen (reine Funktionen): Archivieren gibt das Kürzel frei – „AN“ → „AN_archiv“, bei
 * Kollision „AN_archiv2“, „AN_archiv3“ … Wiederherstellen nimmt den Zusatz wieder ab.
 */

/** Höchstens so viele Archiv-Kürzel je Ausgangskürzel (AN_archiv … AN_archiv99) */
export const MAX_ARCHIVED_CODES = 99;

/** Länge eines Kürzels, wie es im Formular eingegeben werden kann (Archiv-Kürzel dürfen länger sein) */
export const MAX_SERVICE_CODE_LENGTH = 10;

const ARCHIVE_SUFFIX = /_archiv(\d*)$/i;

export function isArchivedCode(code: string): boolean {
  return ARCHIVE_SUFFIX.test(code);
}

/** Kandidaten in Prüf-Reihenfolge: AN_archiv, AN_archiv2 … AN_archiv99 */
export function archivedCodeCandidates(code: string): string[] {
  const base = restoredCode(code);
  return [`${base}_archiv`, ...Array.from({ length: MAX_ARCHIVED_CODES - 1 }, (_, i) => `${base}_archiv${i + 2}`)];
}

/** Ursprüngliches Kürzel ohne Archiv-Zusatz */
export function restoredCode(code: string): string {
  return code.replace(ARCHIVE_SUFFIX, "");
}

/**
 * Taugt ein (z. B. beim Wiederherstellen zurückgewonnenes) Kürzel als normales Kürzel? Leer, zu lang oder selbst
 * noch mit Archiv-Zusatz („AN_archiv_archiv“) → nein. Gleiche Grenzen wie die Eingabe im Formular.
 */
export function isUsableCode(code: string): boolean {
  const c = code.trim();
  return c.length >= 1 && c.length <= MAX_SERVICE_CODE_LENGTH && !isArchivedCode(c);
}

type Settings = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Verweise per Kürzel in organizations.settings mitnehmen – damit ein freigegebenes Kürzel keine Altverweise vererbt:
 *  - settings.onlineBooking.serviceCodes, settings.voice.serviceCodes (Listen; leer = alle → nie leer machen)
 *  - settings.website.serviceDescriptions[code], settings.servicePriceNotes[code]
 * `to` = neues Kürzel (Archivieren „AN“ → „AN_archiv“, Wiederherstellen, Kürzel geändert): Verweise wandern mit.
 * `to` = null (neue Leistung mit diesem Kürzel): Verweise entfernen – in Listen nur, solange sie nicht leer würden
 * (eine leere Liste hieße „alle Leistungen buchbar“).
 * Liefert die geänderten Schlüssel der obersten Ebene (zum Zusammenführen per `settings || patch`) oder null.
 */
export function moveServiceCodeRefs(settings: Settings | null | undefined, from: string, to: string | null): Settings | null {
  if (!settings || from === to) return null;
  const patch: Settings = {};
  const list = (key: "onlineBooking" | "voice") => {
    const box = settings[key];
    if (!isObj(box) || !Array.isArray(box.serviceCodes) || !box.serviceCodes.includes(from)) return;
    const rest = box.serviceCodes.filter((c) => c !== from);
    let next: unknown[];
    if (to !== null) next = box.serviceCodes.map((c) => (c === from ? to : c)).filter((c, i, a) => a.indexOf(c) === i);
    else if (rest.length) next = rest;
    else return;
    patch[key] = { ...box, serviceCodes: next };
  };
  const map = (obj: unknown): Record<string, unknown> | null => {
    if (!isObj(obj) || !Object.prototype.hasOwnProperty.call(obj, from)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (k !== from) out[k] = v;
    if (to !== null) out[to] = obj[from];
    return out;
  };
  list("onlineBooking");
  list("voice");
  const website = settings.website;
  if (isObj(website)) {
    const d = map(website.serviceDescriptions);
    if (d) patch.website = { ...website, serviceDescriptions: d };
  }
  const notes = map(settings.servicePriceNotes);
  if (notes) patch.servicePriceNotes = notes;
  return Object.keys(patch).length ? patch : null;
}
