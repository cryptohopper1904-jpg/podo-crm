/**
 * Baut aus einem Muster mit \b und \w eine Unicode-fähige RegExp (Umlaute, ß zählen als Buchstaben).
 * JavaScript-\b kennt nur ASCII – „Ärzte“ oder „Fuß“ würden sonst nicht erkannt.
 */
const W = "[\\p{L}\\p{N}_]";
const NW = "[^\\p{L}\\p{N}_]";
export function wordRegex(source: string, flags = "i"): RegExp {
  const src = source
    .replace(/\\b/g, `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`)
    .replace(/\\w/g, W)
    .replace(/\\W/g, NW);
  return new RegExp(src, flags.includes("u") ? flags : flags + "u");
}
