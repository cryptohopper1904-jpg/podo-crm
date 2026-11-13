/**
 * Ob eine Anfrage als schreibend gilt (Nur-Lesen-Modus, Support-Freigabe „read“, support.view-Protokoll).
 *
 * Grundregel: alles außer GET/HEAD ist schreibend (FAIL CLOSED, auch bei fehlender Methode).
 * Ausnahme nur für ausdrücklich gelistete Route-Handler, die POST allein deshalb nutzen, damit Eingaben nicht in
 * URL/Proxy-Logs landen, und die nachweislich nur lesen. Abgleich auf den exakten Pfad, den der Proxy
 * (src/proxy.ts) setzt – nicht vom Client fälschbar. Server Actions (POST auf Seitenpfade) fallen nie darunter.
 * Neue Einträge: Review! Der Handler darf nichts schreiben (außer Audit) und prüft selbst ein Lese-Recht.
 */
export const READ_ONLY_POST_PATHS: Readonly<Record<string, string>> = {
  "/api/patienten/vorschlaege": "Live-Patientensuche: POST nur, damit der Suchtext nicht in URL/Logs steht",
};

export function isMutatingRequest(method: string | null | undefined, path: string | null | undefined): boolean {
  // ohne Proxy-Kennung (Methode UND Pfad setzt der Proxy immer gemeinsam) → schreibend
  if (!method || !path) return true;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  if (m === "POST" && Object.hasOwn(READ_ONLY_POST_PATHS, path)) return false;
  return true;
}
