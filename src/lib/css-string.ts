/**
 * Beliebigen Text als CSS-Zeichenkette (z. B. für `content:` in @page-Seitenrand-Boxen) ausgeben.
 * Allowlist: Buchstaben, Ziffern, Leerzeichen und . , / _ – - bleiben stehen, alles andere wird als
 * CSS-Hex-Escape `\<hex> ` maskiert (auch Steuerzeichen wie Form-Feed U+000C, das einen CSS-String sonst
 * beendet, sowie " \ < > { } und Zeilenumbrüche). So kann der Wert weder den String noch das <style> verlassen.
 */
export function cssString(value: string): string {
  return `"${value.replace(/[^\p{L}\p{N} .,/_–-]/gu, (c) => `\\${c.codePointAt(0)!.toString(16)} `)}"`;
}
