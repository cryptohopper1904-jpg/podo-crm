/**
 * Unterschrift der versicherten Person je Behandlung (GKV-Leistungsnachweis, Vertrag § 125 SGB V Podologie, Anlage 3
 * Buchst. o) – gemeinsame Konstanten und reine Prüfungen (Server und Browser).
 */

/**
 * Wer bestätigt: die versicherte Person selbst, rechtliche Betreuung bzw. Bevollmächtigte:r (Vertretung), Angehörige:r
 * oder Pflegekraft der Einrichtung (z. B. Pflegeheim; nur Bestätigung der Leistung, keine Vertretung) – Review R2-10.
 */
export const SIGNER_ROLES = ["insured", "guardian", "relative", "care_staff"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export const SIGNER_ROLE_LABEL: Record<SignerRole, string> = {
  insured: "Versicherte:r",
  guardian: "Rechtliche Betreuung / Bevollmächtigte:r",
  relative: "Angehörige:r",
  care_staff: "Pflegekraft der Einrichtung",
};

/** Größenlimit der PNG-Datei (DB-CHECK in Migration 0064 identisch) */
export const MAX_SIGNATURE_BYTES = 200_000;
/** data:-URL (Base64, +33 %) inkl. Präfix */
export const MAX_SIGNATURE_DATAURL_CHARS = Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 64;
/** Abmessungen der Zeichenfläche in Pixeln (feste Auflösung, unabhängig vom Gerät) – der Server verlangt genau diese */
export const SIGNATURE_WIDTH = 900;
export const SIGNATURE_HEIGHT = 300;

export const PAPER_SIGNATURE_LABEL = "Unterschrift auf der Papier-Verordnung (Rückseite) erfasst";
export const SIGNATURE_MISSING = "Unterschrift fehlt";
