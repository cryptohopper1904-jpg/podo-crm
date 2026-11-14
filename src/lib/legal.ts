/**
 * Versionen der Vertragsdokumente (docs/legal/AGB.md, docs/legal/AVV.md). Bei inhaltlichen Änderungen
 * hochzählen – die Zustimmung wird je Praxis mit Version, Zeitpunkt und Person gespeichert
 * (organizations.settings.legalAcceptance).
 */
export const LEGAL_VERSIONS = { agb: "0.4", avv: "0.4", datenschutz: "0.5" } as const;
export const LEGAL_VERSION = `agb-${LEGAL_VERSIONS.agb}+avv-${LEGAL_VERSIONS.avv}`;

export type LegalAcceptance = { agb: string; avv: string; version: string; at: string; by: string };

export function legalAcceptance(userId: string, now: Date = new Date()): LegalAcceptance {
  return { agb: LEGAL_VERSIONS.agb, avv: LEGAL_VERSIONS.avv, version: LEGAL_VERSION, at: now.toISOString(), by: userId };
}

/** Ab dieser AVV-Version gilt die Standardweisung zur Löschung unbestätigter Online-Anfragen (AVV § 3 Nr. 4) */
export const RETENTION_MIN_AVV = "0.3";

/** Ab dieser AVV-Version gilt der Nur-Lesen-Modus nach Vertragsende mit Löschung nach Ankündigung (AVV § 10 Nr. 2) */
export const READONLY_MIN_AVV = "0.4";

/** Hinweis im AVV-Banner, solange die bisherige Zustimmung älter als READONLY_MIN_AVV ist (Recht R-1) */
export const AVV_READONLY_NOTE =
  "Nach Vertragsende bleiben deine Daten höchstens 12 Monate im Nur-Lesen-Modus lesbar und exportierbar und werden nach Ankündigung (mindestens 30 Tage vorher) gelöscht (§ 10 Nr. 2).";

/**
 * Welche Neuerungen das AVV-Banner nennt – abhängig von der bisher akzeptierten Version: Löschweisung für Online-Anfragen
 * (§ 3 Nr. 4, ab 0.3) und Nur-Lesen-Modus/Löschung nach Vertragsende (§ 10 Nr. 2, ab 0.4).
 */
export function avvBannerNews(previous: string | null): { retention: boolean; readonly: string | null } {
  const retention = !versionAtLeast(previous, RETENTION_MIN_AVV);
  const readonly = versionAtLeast(previous, READONLY_MIN_AVV) ? null : `${retention ? "Außerdem neu: " : "Neu ist u. a.: "}${AVV_READONLY_NOTE}`;
  return { retention, readonly };
}

/** „0.3“ → [0, 3]; ungültig → null */
function parseVersion(v: unknown): number[] | null {
  if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v)) return null;
  return v.split(".").map(Number);
}

/** a ≥ b (numerisch je Stelle: „0.10“ > „0.3“) */
export function versionAtLeast(a: unknown, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Gespeicherte Zustimmung der Praxis (organizations.settings.legalAcceptance), sonst null */
export function storedLegalAcceptance(settings: Record<string, unknown> | null | undefined): LegalAcceptance | null {
  const a = settings?.legalAcceptance as Partial<LegalAcceptance> | undefined;
  return a && typeof a === "object" && typeof a.avv === "string" ? (a as LegalAcceptance) : null;
}

/** Hat die Praxis die AVV mindestens in Version `min` akzeptiert? */
export function avvAcceptedAtLeast(settings: Record<string, unknown> | null | undefined, min: string = LEGAL_VERSIONS.avv): boolean {
  return versionAtLeast(storedLegalAcceptance(settings)?.avv, min);
}

/**
 * Nachträgliche Zustimmung zur aktuellen AVV (Hinweis in den Einstellungen für die Inhaber:in): AGB-Stand bleibt wie
 * gespeichert, die bisherige Zustimmung wird in `previous` mitgeführt (Nachweis).
 */
export function avvReacceptance(prev: LegalAcceptance | null, userId: string, now: Date = new Date()) {
  const agb = prev?.agb ?? null;
  return {
    agb,
    avv: LEGAL_VERSIONS.avv,
    version: `agb-${agb ?? "?"}+avv-${LEGAL_VERSIONS.avv}`,
    at: now.toISOString(),
    by: userId,
    ...(prev ? { previous: { agb: prev.agb, avv: prev.avv, at: prev.at, by: prev.by } } : {}),
  };
}
