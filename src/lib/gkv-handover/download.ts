/**
 * Erst-Export des Übergabepakets im Browser (Laufseite): Fehlerantwort der Route in eine verständliche Meldung
 * übersetzen und den Dateinamen aus Content-Disposition lesen. Reine Funktionen, ohne DOM.
 */

/** Fallback, wenn die Antwort keine (lesbare) Meldung enthält */
export function handoverErrorText(status: number, serverMessage: string | null | undefined): string {
  const msg = typeof serverMessage === "string" ? serverMessage.trim().slice(0, 500) : "";
  if (msg) return msg;
  if (status === 429) return "Zu viele Exporte in kurzer Zeit – bitte eine Minute warten und dann erneut versuchen.";
  if (status === 403) return "Kein Zugriff auf den Export dieses Abrechnungslaufs.";
  if (status === 404) return "Abrechnungslauf nicht gefunden.";
  if (status === 409) return "Das Übergabepaket konnte nicht erzeugt werden.";
  return `Der Export ist fehlgeschlagen (Fehler ${status}). Bitte versuch es erneut.`;
}

/** Meldung aus einer JSON-Fehlerantwort ({ error }) – sonst null */
export function errorFromBody(body: unknown): string | null {
  return body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
}

/** Dateiname aus Content-Disposition (attachment; filename="…"), nur unkritische Zeichen; sonst Fallback */
export function filenameFromDisposition(header: string | null | undefined, fallback = "Uebergabepaket.zip"): string {
  const m = header ? /filename="([^"]+)"/i.exec(header) : null;
  const name = m?.[1] ?? "";
  return /^[A-Za-z0-9._-]{1,120}$/.test(name) ? name : fallback;
}

/** Ohne Sitzung leitet der Proxy auf /login um; die Antwort ist dann kein Übergabepaket */
export const SESSION_EXPIRED = "Sitzung abgelaufen – bitte neu anmelden.";

/** Download nach angenommenem Export abgebrochen (der Lauf kann bereits übergeben sein) */
export const DOWNLOAD_ABORTED =
  "Der Download wurde unterbrochen. Falls der Lauf jetzt als übergeben angezeigt wird, lade das Paket über den Nachdruck herunter.";

/** Weiterleitung bei fetch(…, { redirect: "manual" }) (opaqueredirect) oder doch gefolgt (redirected) */
export function isRedirect(res: { type?: string; redirected?: boolean; status: number }): boolean {
  return res.type === "opaqueredirect" || res.redirected === true || (res.status >= 300 && res.status < 400);
}

/** Nur eine ZIP-Antwort wird als Übergabepaket gespeichert */
export function isZipResponse(contentType: string | null | undefined): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "application/zip";
}
