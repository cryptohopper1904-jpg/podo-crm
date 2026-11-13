/**
 * Cache-Regeln des Service Workers (src/lib/pwa/service-worker.ts, ausgeliefert unter /sw.js).
 *
 * Grundsatz (Gesundheitsdaten, DSGVO): Es wird NUR gecacht, was für alle gleich und frei von Praxis-/Patientendaten
 * ist – gehashte Next.js-Bundles/CSS/Schriften (/_next/static), Icons, Startbilder, Logo – plus die statische
 * Offline-Seite. Niemals HTML-Seiten der Praxis, API-Antworten, RSC-Daten, Server-Action-POSTs, PDFs, Fotos,
 * Exporte oder Bilder aus /_next/image.
 *
 * WICHTIG: classifyRequest wird per Function.prototype.toString() in den Service Worker übernommen. Sie muss deshalb
 * vollständig in sich geschlossen bleiben: keine Importe, keine Bezüge auf Konstanten außerhalb der Funktion, keine
 * Syntax, für die der Compiler Hilfsfunktionen einfügt (Objekt-Spread, async/await, Klassen, Destrukturierung mit
 * Standardwerten). src/lib/pwa/sw-rules.test.ts prüft das am erzeugten Skript.
 */

export type SwRequestInfo = {
  /** absolute URL */
  url: string;
  method: string;
  /** Request.mode ("navigate" bei Seitenaufrufen) */
  mode: string;
  /** Origin des Service Workers (self.location.origin) */
  origin: string;
};

/**
 * - "static": cache-first (unveränderliche, gehashte bzw. öffentliche Dateien)
 * - "navigate": nur Netz; bei fehlender Verbindung die vorab gespeicherte Offline-Seite (die Seite selbst wird nie gecacht)
 * - "network": Service Worker greift nicht ein (Browser-Standardverhalten, nichts wird gespeichert)
 */
export type SwDecision = "static" | "navigate" | "network";

export function classifyRequest(req: SwRequestInfo): SwDecision {
  // Nur lesende Anfragen; Server Actions (POST), Uploads usw. laufen immer direkt ans Netz
  if (req.method !== "GET") return "network";
  let u: URL;
  try {
    u = new URL(req.url);
  } catch (e) {
    void e;
    return "network";
  }
  if (u.origin !== req.origin) return "network";
  const p = u.pathname;
  if (req.mode === "navigate") {
    // Seiten für Patient:innen und Praxis-Websites: kein PodoHero-Offline-Hinweis, Browser zeigt seinen eigenen Fehler
    const patientFacing = ["/p/", "/portal", "/buchen", "/anamnese", "/abmelden", "/aktion"];
    for (let i = 0; i < patientFacing.length; i++) {
      const pre = patientFacing[i];
      if (p === pre || p.indexOf(pre.charAt(pre.length - 1) === "/" ? pre : pre + "/") === 0) return "network";
    }
    // Dateiabrufe als Seite (PDF, Export, Download) nie abfangen
    if (p.indexOf("/api/") === 0 || /\.[a-z0-9]{2,5}$/i.test(p)) return "network";
    return "navigate";
  }
  // RSC-Daten (Client-Navigation) und alles mit Abfrageparametern außerhalb von /_next/static nie cachen
  if (u.searchParams.has("_rsc")) return "network";
  if (p.indexOf("/_next/static/") === 0) return "static";
  if (u.search) return "network";
  if (p.indexOf("/icons/") === 0 || p.indexOf("/splash/") === 0 || p.indexOf("/brand/") === 0) {
    return /\.(png|svg|ico|webp)$/i.test(p) ? "static" : "network";
  }
  return "network";
}
