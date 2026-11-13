/**
 * Zurück-Links auf Detailseiten (PWA auf dem iPad hat keine Browser-Zurück-Taste).
 * Ziel ist immer die logische Elternseite, nicht history.back(). Listen hängen ihren aktuellen Zustand
 * (Suche, Filter, Datum …) als `?von=<Pfad+Query>` an den Link zur Detailseite; die Detailseite übernimmt ihn nur,
 * wenn er ein interner relativer Pfad DERSELBEN Elternseite ist – sonst den Standard-Elternpfad (kein offener Redirect).
 */
import { isSafeReturnPath } from "./safe-path";

export const RETURN_PARAM = "von";

const pathOf = (href: string) => href.split(/[?#]/, 1)[0];

/**
 * Rücksprungziel: `von`, falls sicher und auf derselben Elternseite wie `fallback` – oder auf einer der ausdrücklich
 * erlaubten weiteren Elternseiten `also` (exakter Pfadvergleich, z. B. Termin aus „Heute“) –, sonst `fallback`.
 */
export function backHref(fallback: string, von: unknown, also: readonly string[] = []): string {
  if (typeof von !== "string" || !von) return fallback;
  if (!isSafeReturnPath(von)) return fallback;
  const path = pathOf(von);
  return path === pathOf(fallback) || also.includes(path) ? von : fallback;
}

/** encodeURIComponent plus ' ( ) * ! ~ (RFC 3986) – sonst lehnt isSafeReturnPath z. B. die Suche „D'Angelo“ ab. */
const encodeStrict = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Pfad + Query einer Liste als Rücksprungziel. Leere Werte entfallen; Werte werden mit encodeURIComponent
 * strikt kodiert (Leerzeichen als %20 statt „+“, dazu ' ( ) * ! ~), damit isSafeReturnPath sie annimmt.
 */
export function returnPath(pathname: string, params: Record<string, string | null | undefined> = {}): string {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([k, v]) => `${encodeStrict(k)}=${encodeStrict(v)}`)
    .join("&");
  return q ? `${pathname}?${q}` : pathname;
}

/**
 * Link zur Detailseite mit Rücksprungziel. Ohne Query (ungefilterte Standard-Elternseite) bleibt der Link unverändert;
 * `always` hängt `von` auch ohne Query an – für weitere erlaubte Elternseiten (z. B. „/heute“ statt Kalender).
 */
export function withReturn(href: string, from: string, always = false): string {
  if (!from || (!always && !from.includes("?"))) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${RETURN_PARAM}=${encodeURIComponent(from)}`;
}
