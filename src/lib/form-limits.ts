/** Obergrenzen für öffentliche Formulare (vor Object.fromEntries/Parsing prüfen). */
export const MAX_FORM_ENTRIES = 80;
export const MAX_FORM_CHARS = 30_000;

/** false, wenn zu viele Felder, Dateien oder zu viel Text gesendet wurden. */
export function formWithinLimits(form: Iterable<[string, FormDataEntryValue]>, maxEntries = MAX_FORM_ENTRIES, maxChars = MAX_FORM_CHARS): boolean {
  let n = 0;
  let chars = 0;
  for (const [k, v] of form) {
    if (++n > maxEntries) return false;
    if (typeof v !== "string") return false; // keine Dateien im Anamnesebogen
    chars += k.length + v.length;
    if (chars > maxChars) return false;
  }
  return true;
}
