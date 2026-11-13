/**
 * Plattform-Erkennung für die Installationshilfe (reine Funktionen, im Browser und in Tests nutzbar).
 * Nur zur Anzeige der passenden Anleitung – nie für Sicherheitsentscheidungen.
 */
export type InstallPlatform = "ios" | "android" | "desktop";

/**
 * iPadOS ab 13 meldet sich als „Macintosh“; erkennbar an Touch-Punkten (Mac-Desktops haben 0).
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

/** iOS-Browser, die nicht Safari sind (Chrome, Firefox, Edge …) – ab iOS 16.4 ebenfalls über „Teilen“ installierbar */
export function isIosOtherBrowser(userAgent: string): boolean {
  return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
}
