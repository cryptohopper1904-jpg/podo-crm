/**
 * Zurück-Links auf Detailseiten (PWA auf dem iPad hat keine Browser-Zurück-Taste).
 * Ziel ist immer die logische Elternseite, nicht history.back(). Listen hängen ihren aktuellen Zustand
 * (Suche, Filter, Datum …) als `?von=<Pfad+Query>` an den Link zur Detailseite; die Detailseite übernimmt ihn nur,
 * wenn er ein interner relativer Pfad DERSELBEN Elternseite ist – sonst den Standard-Elternpfad (kein offener Redirect).
 */
import { isSafeReturnPath } from "./safe-path";

export const RETURN_PARAM = "von";

const pathOf = (href: string) => href.split(/[?#]/, 1)[0];

/** Rücksprungziel: `von`, falls sicher und auf derselben Elternseite wie `fallback`, sonst `fallback`. */
export function backHref(fallback: string, von: unknown): string {
  if (typeof von !== "string" || !von) return fallback;
  if (!isSafeReturnPath(von)) return fallback;
  return pathOf(von) === pathOf(fallback) ? von : fallback;
}

/**
 * Pfad + Query einer Liste als Rücksprungziel. Leere Werte entfallen; Werte werden mit encodeURIComponent
 * kodiert (Leerzeichen als %20 statt „+“), damit isSafeReturnPath sie annimmt.
 */
export function returnPath(pathname: string, params: Record<string, string | null | undefined> = {}): string {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return q ? `${pathname}?${q}` : pathname;
}

/** Link zur Detailseite mit Rücksprungziel; ohne Query (ungefilterte Liste) bleibt der Link unverändert. */
export function withReturn(href: string, from: string): string {
  if (!from.includes("?")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${RETURN_PARAM}=${encodeURIComponent(from)}`;
}
