/**
 * Versionen der Vertragsdokumente (docs/legal/AGB.md, docs/legal/AVV.md). Bei inhaltlichen Änderungen
 * hochzählen – die Zustimmung wird je Praxis mit Version, Zeitpunkt und Person gespeichert
 * (organizations.settings.legalAcceptance).
 */
export const LEGAL_VERSIONS = { agb: "0.2", avv: "0.2" } as const;
export const LEGAL_VERSION = `agb-${LEGAL_VERSIONS.agb}+avv-${LEGAL_VERSIONS.avv}`;

export type LegalAcceptance = { agb: string; avv: string; version: string; at: string; by: string };

export function legalAcceptance(userId: string, now: Date = new Date()): LegalAcceptance {
  return { agb: LEGAL_VERSIONS.agb, avv: LEGAL_VERSIONS.avv, version: LEGAL_VERSION, at: now.toISOString(), by: userId };
}
